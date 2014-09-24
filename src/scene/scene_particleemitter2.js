// Mr F
pc.extend(pc.scene, function() {
    // TODO: carrying graphicsDevice everywhere around isn't good, should be able to globally address it

    var particleVerts = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1]
    ];

    var modeGPU = 0;
    var modeCPU = 1;

    var _createTexture = function(device, width, height, pixelData, is8Bit, mult8Bit) {
        var texture = new pc.gfx.Texture(device, {
            width: width,
            height: height,
            format: (is8Bit == true ? pc.gfx.PIXELFORMAT_R8_G8_B8_A8 : pc.gfx.PIXELFORMAT_RGBA32F),
            cubemap: false,
            autoMipmap: false
        });
        var pixels = texture.lock();

        if (is8Bit) {
            var temp = new Uint8Array(pixelData.length);
            for (var i = 0; i < pixelData.length; i++) {
                temp[i] = pixelData[i] * mult8Bit * 255;
            }
            pixelData = temp;
        }

        pixels.set(pixelData);

        texture.unlock();

        texture.addressU = pc.gfx.ADDRESS_CLAMP_TO_EDGE;
        texture.addressV = pc.gfx.ADDRESS_CLAMP_TO_EDGE;
        texture.minFilter = pc.gfx.FILTER_NEAREST;
        texture.magFilter = pc.gfx.FILTER_NEAREST;

        return texture;
    };


    function saturate(x) {
        return Math.max(Math.min(x, 1), 0);
    }

    function glMod(x, y) {
        return x - y * Math.floor(x / y);
    }

    function tex1D(arr, u, chans, outArr, test) {
        if ((chans == undefined) || (chans < 2)) {
            u *= arr.length - 1;
            var A = arr[Math.floor(u)];
            var B = arr[Math.ceil(u)];
            var C = u % 1;
            return pc.math.lerp(A, B, C);
        }

        u *= arr.length / chans - 1;
        if (outArr == undefined) outArr = [];
        for (var i = 0; i < chans; i++) {
            var A = arr[Math.floor(u) * chans + i];
            var B = arr[Math.ceil(u) * chans + i];
            var C = u % 1;
            outArr[i] = pc.math.lerp(A, B, C);
        }
        return outArr;
    }


    // Linearly interpolated values container
    var LinearGraph = function LinearGraph(numValues) {
        this.keys = [];
        this.dirty = true;
        this.numVals = numValues == undefined ? 1 : numValues;
        this.smoothstep = true;

        this.AddKey = function(time, value) { // time is supposed to be normalized
            this.keys.push([time, value]);
            this.dirty = true;
        }

        this.prepare = function() {
            this.keys.sort(function(a, b) {
                return a[0] - b[0];
            });
            this.dirty = false;
        }

        this.GetValue = function(time) {
            if (this.dirty) this.prepare();
            for (var i = 0; i < this.keys.length; i++) {
                var keyTime = this.keys[i][0];
                if (keyTime == time) {
                    return this.keys[i][1];
                } else if (keyTime < time) {
                    var keyTimeNext = this.keys[i + 1][0];
                    if (keyTimeNext > time) {
                        var keyValA = this.keys[i][1];
                        var keyValB = this.keys[i + 1][1];
                        var interpolation = (time - keyTime) / (keyTimeNext - keyTime);

                        if (this.smoothstep) interpolation = ((interpolation) * (interpolation) * (3 - 2 * (interpolation))); // smoothstep

                        if (keyValA instanceof Array) {
                            var interpolated = new Array(keyValA.length);
                            for (var v = 0; v < keyValA.length; v++) interpolated[v] = pc.math.lerp(keyValA[v], keyValB[v], interpolation);
                            return interpolated;
                        } else {
                            return pc.math.lerp(keyValA, keyValB, interpolation);
                        }

                    }
                }
            }
            return null;
        }

        this.Quantize = function(precision, blur) {
            precision = Math.max(precision, 2);
            var colors = new Float32Array(precision * this.numVals);
            var step = 1.0 / (precision - 1);
            for (var i = 0; i < precision; i++) // quantize graph to table of interpolated values
            {
                var color = this.GetValue(step * i);
                if (this.numVals == 1) {
                    colors[i] = color;
                } else {
                    for (var j = 0; j < this.numVals; j++) colors[i * this.numVals + j] = color[j]
                }
            }

            if (blur > 0) {
                var colors2 = new Float32Array(precision * this.numVals);
                var numSamples = blur * 2 + 1;
                for (var i = 0; i < precision; i++) {
                    if (this.numVals == 1) {
                        colors2[i] = 0;
                        for (var sample = -blur; sample <= blur; sample++) {
                            var sampleAddr = Math.max(Math.min(i + sample, precision - 1), 0);
                            colors2[i] += colors[sampleAddr];
                        }
                        colors2[i] /= numSamples;
                    } else {
                        for (var chan = 0; chan < this.numVals; chan++) colors2[i * this.numVals + chan] = 0;
                        for (var sample = -blur; sample <= blur; sample++) {
                            var sampleAddr = Math.max(Math.min(i + sample, precision - 1), 0);
                            for (var chan = 0; chan < this.numVals; chan++) colors2[i * this.numVals + chan] += colors[sampleAddr * this.numVals + chan];
                        }
                        for (var chan = 0; chan < this.numVals; chan++) colors2[i * this.numVals + chan] /= numSamples;
                    }
                }
                colors = colors2;
            }

            return colors;
        }
    };

    var defaultLinearGraph = new LinearGraph();
    defaultLinearGraph.AddKey(0, 0);
    defaultLinearGraph.AddKey(1, 0);

    var defaultLinearGraph3 = new LinearGraph(3);
    defaultLinearGraph3.AddKey(0, [0, 0, 0]);
    defaultLinearGraph3.AddKey(1, [0, 0, 0]);

    var defaultParamTex = null;

    var localOffsetVec = new pc.Vec3();
    var worldOffsetVec = new pc.Vec3();
    var rotMat = new pc.Mat4();

    var setPropertyTarget;
    var setPropertyOptions;

    function setProperty(pName, defaultVal) {
        setPropertyTarget[pName] = typeof setPropertyOptions[pName] !== 'undefined' ? setPropertyOptions[pName] : defaultVal;
    }

    function Pack3NFloats(a, b, c) {
        var packed = ((a * 255) << 16) | ((b * 255) << 8) | (c * 255);
        return (packed) / (1 << 24);
    }

    function PackTextureXYZ_N3(qXYZ, qA, qB, qC) {
        var colors = new Array(qA.length * 4);
        for (var i = 0; i < qA.length; i++) {
            colors[i * 4] = qXYZ[i * 3];
            colors[i * 4 + 1] = qXYZ[i * 3 + 1];
            colors[i * 4 + 2] = qXYZ[i * 3 + 2];

            colors[i * 4 + 3] = Pack3NFloats(qA[i], qB[i], qC[i]);
        }
        return colors;
    }

    function PackTextureXYZ_N3_Array(qXYZ, qXYZ2) {
        var num = qXYZ.length / 3;
        var colors = new Array(num * 4);
        for (var i = 0; i < num; i++) {
            colors[i * 4] = qXYZ[i * 3];
            colors[i * 4 + 1] = qXYZ[i * 3 + 1];
            colors[i * 4 + 2] = qXYZ[i * 3 + 2];

            colors[i * 4 + 3] = Pack3NFloats(qXYZ2[i * 3], qXYZ2[i * 3 + 1], qXYZ2[i * 3 + 2]);
        }
        return colors;
    }

    function PackTextureRGBA(qRGB, qA) {
        var colors = new Array(qA.length * 4);
        for (var i = 0; i < qA.length; i++) {
            colors[i * 4] = qRGB[i * 3];
            colors[i * 4 + 1] = qRGB[i * 3 + 1];
            colors[i * 4 + 2] = qRGB[i * 3 + 2];

            colors[i * 4 + 3] = qA[i];
        }
        return colors;
    }

    function PackTexture2_N3_Array(qA, qB, qXYZ) {
        var colors = new Array(qA.length * 4);
        for (var i = 0; i < qA.length; i++) {
            colors[i * 4] = qA[i];
            colors[i * 4 + 1] = qB[i];
            colors[i * 4 + 2] = 0;

            colors[i * 4 + 3] = Pack3NFloats(qXYZ[i * 3], qXYZ[i * 3 + 1], qXYZ[i * 3 + 2]);
        }
        return colors;
    }


    function createOffscreenTarget(gd, camera) {
        var rect = camera.rect;

        var width = Math.floor(rect.z * gd.width);
        var height = Math.floor(rect.w * gd.height);

        var colorBuffer = new pc.gfx.Texture(gd, {
            format: pc.gfx.PIXELFORMAT_R8_G8_B8_A8,
            width: width,
            height: height
        });

        colorBuffer.minFilter = pc.gfx.FILTER_NEAREST;
        colorBuffer.magFilter = pc.gfx.FILTER_NEAREST;
        colorBuffer.addressU = pc.gfx.ADDRESS_CLAMP_TO_EDGE;
        colorBuffer.addressV = pc.gfx.ADDRESS_CLAMP_TO_EDGE;

        return new pc.gfx.RenderTarget(gd, colorBuffer, {
            depth: true
        });
    }


    var ParticleEmitter2 = function ParticleEmitter2(graphicsDevice, options) {
        this.graphicsDevice = graphicsDevice;
        var gd = graphicsDevice;
        var precision = 32;
        this.precision = precision;

        // Global system parameters
        setPropertyTarget = this;
        setPropertyOptions = options;
        setProperty("numParticles", 1);                          // Amount of particles allocated (max particles = max GL texture width at this moment)
        setProperty("rate", 1);                                  // Emission rate
        setProperty("lifetime", 50);                             // Particle lifetime
        setProperty("birthBounds", new pc.Vec3(0, 0, 0));        // Spawn point divergence
        setProperty("wrapBounds", undefined);
        setProperty("wind", new pc.Vec3(0, 0, 0));               // Wind velocity
        setProperty("smoothness", 4);                            // Blurring width for graphs
        setProperty("texture", null);
        setProperty("textureNormal", null);
        setProperty("textureAsset", null);
        setProperty("textureNormalAsset", null);
        setProperty("oneShot", false);
        setProperty("deltaRandomness", 0.0);                     // Randomizes particle simulation speed [0-1] per frame
        setProperty("deltaRandomnessStatic", 0.0);                     // Randomizes particle simulation speed [0-1] (one value during whole particle life)
        setProperty("sort", 0);                                  // Sorting mode: 0 = none, 1 = by distance, 2 = by life, 3 = by -life;  Forces CPU mode if not 0
        setProperty("mode", this.sort>0? "CPU" : "GPU");
        setProperty("camera", undefined);
        setProperty("scene", undefined);
        setProperty("lighting", false);
        setProperty("softerLighting", false);
        setProperty("stretch", 0.0);
        setProperty("depthSoftening", 0);
        setProperty("maxEmissionTime", 15);
        setProperty("mesh", undefined);                          // Mesh to be used as particle. Vertex buffer is supposed to hold vertex position in first 3 floats of each vertex
                                                                 // Leave undefined to use simple quads
        setProperty("srgb", true);
        setProperty("ztest", false);
        this.mode = (this.mode == "CPU" ? modeCPU : modeGPU);

        if (!(gd.extTextureFloat && (gd.maxVertexTextures >= 4))) this.mode = modeCPU;

        this.frameRandom = new pc.Vec3(0, 0, 0);

        if (this.depthSoftening > 0) {
            if (this.camera != undefined) {
                if ((this.camera.camera.camera._depthTarget == undefined) || (this.camera.camera.camera._depthTarget == null)) {
                    this.camera.camera.camera._depthTarget = createOffscreenTarget(this.graphicsDevice, this.camera.camera);
                    this.camera.camera._depthTarget = this.camera.camera.camera._depthTarget;
                    this.camera._depthTarget = this.camera.camera.camera._depthTarget;
                }
            }
        }

        if (this.lighting) {
            this.lightCube = new Float32Array(6 * 3);

            this.lightCubeDir = new Array(6);
            this.lightCubeDir[0] = new pc.Vec3(-1, 0, 0);
            this.lightCubeDir[1] = new pc.Vec3(1, 0, 0);
            this.lightCubeDir[2] = new pc.Vec3(0, -1, 0);
            this.lightCubeDir[3] = new pc.Vec3(0, 1, 0);
            this.lightCubeDir[4] = new pc.Vec3(0, 0, -1);
            this.lightCubeDir[5] = new pc.Vec3(0, 0, 1);
        }

        // Time-dependent parameters
        setProperty("graphLocalOffset", defaultLinearGraph3);
        setProperty("graphWorldOffset", defaultLinearGraph3);
        setProperty("graphColor", defaultLinearGraph3);
        setProperty("graphPosDiv", defaultLinearGraph3);
        setProperty("graphPosWorldDiv", defaultLinearGraph3);
        setProperty("graphAngle", defaultLinearGraph);
        setProperty("graphScale", defaultLinearGraph);
        setProperty("graphAlpha", defaultLinearGraph);
        setProperty("graphScaleDiv", defaultLinearGraph);
        setProperty("graphAngleDiv", defaultLinearGraph);
        setProperty("graphAlphaDiv", defaultLinearGraph);

        this.qLocalOffset = this.graphLocalOffset.Quantize(precision, this.smoothness);
        this.qWorldOffset = this.graphWorldOffset.Quantize(precision, this.smoothness);
        this.qColor = this.graphColor.Quantize(precision, this.smoothness);
        this.qPosDiv = this.graphPosDiv.Quantize(precision, this.smoothness);
        this.qPosWorldDiv = this.graphPosWorldDiv.Quantize(precision, this.smoothness);

        this.qAngle = this.graphAngle.Quantize(precision, this.smoothness);
        this.qScale = this.graphScale.Quantize(precision, this.smoothness);
        this.qAlpha = this.graphAlpha.Quantize(precision, this.smoothness);
        this.qScaleDiv = this.graphScaleDiv.Quantize(precision, this.smoothness);
        this.qAngleDiv = this.graphAngleDiv.Quantize(precision, this.smoothness);
        this.qAlphaDiv = this.graphAlphaDiv.Quantize(precision, this.smoothness);

        this.colorMult = 1;
        for (var i = 0; i < this.qColor.length; i++) {
            this.colorMult = Math.max(this.colorMult, this.qColor[i]);
        }

        if (this.mode == modeGPU) {
            this.internalTex0 = _createTexture(gd, precision, 1, PackTextureXYZ_N3(this.qLocalOffset, this.qScaleDiv, this.qAngleDiv, this.qAlphaDiv));
            this.internalTex1 = _createTexture(gd, precision, 1, PackTextureXYZ_N3_Array(this.qWorldOffset, this.qPosDiv));
            this.internalTex2 = _createTexture(gd, precision, 1, PackTexture2_N3_Array(this.qAngle, this.qScale, this.qPosWorldDiv));
        }
        this.internalTex3 = _createTexture(gd, precision, 1, PackTextureRGBA(this.qColor, this.qAlpha), true, 1.0 / this.colorMult);


        // Dynamic simulation data
        this.lifeAndSourcePos = new Float32Array(this.numParticles * 4);
        for (var i = 0; i < this.numParticles; i++) {
            this.lifeAndSourcePos[i * 4] = this.birthBounds.x * (Math.random() * 2 - 1);
            this.lifeAndSourcePos[i * 4 + 1] = this.birthBounds.y * (Math.random() * 2 - 1);
            this.lifeAndSourcePos[i * 4 + 2] = this.birthBounds.z * (Math.random() * 2 - 1);
            this.lifeAndSourcePos[i * 4 + 3] = -this.rate * i;
        }
        this.lifeAndSourcePosStart = new Float32Array(this.numParticles * 4);
        for (var i = 0; i < this.lifeAndSourcePosStart.length; i++) this.lifeAndSourcePosStart[i] = this.lifeAndSourcePos[i];

        if (this.mode == modeCPU) {
            this.vbToSort = new Array(this.numParticles);
            this.vbOld = new Float32Array(this.numParticles * 4 * 4);
            this.particleDistance = new Float32Array(this.numParticles);
            this.particleNoize = new Float32Array(this.numParticles);
            for (var i = 0; i < this.numParticles; i++) {
                this.particleNoize[i] = Math.random();
            }
        }

        if (this.mode == modeGPU) {
            this.texLifeAndSourcePosIN = _createTexture(gd, this.numParticles, 1, this.lifeAndSourcePos);
            this.texLifeAndSourcePosOUT = _createTexture(gd, this.numParticles, 1, this.lifeAndSourcePos);
            this.texLifeAndSourcePosStart = _createTexture(gd, this.numParticles, 1, this.lifeAndSourcePosStart);

            this.rtLifeAndSourcePosIN = new pc.gfx.RenderTarget(gd, this.texLifeAndSourcePosIN, {
                depth: false
            });
            this.rtLifeAndSourcePosOUT = new pc.gfx.RenderTarget(gd, this.texLifeAndSourcePosOUT, {
                depth: false
            });
            this.swapTex = false;
        }

        var shaderCodeRespawn = shaderChunks.particleUpdaterStartPS;
        shaderCodeRespawn += shaderChunks.particleUpdaterRespawnPS;
        shaderCodeRespawn += shaderChunks.particleUpdaterEndPS;

        var shaderCodeNoRespawn = shaderChunks.particleUpdaterStartPS;
        shaderCodeNoRespawn += shaderChunks.particleUpdaterEndPS;

        this.shaderParticleUpdateRespawn = shaderChunks.CreateShaderFromCode(gd, shaderChunks.fullscreenQuadVS, shaderCodeRespawn, "fsQuad" + false);
        this.shaderParticleUpdateNoRespawn = shaderChunks.CreateShaderFromCode(gd, shaderChunks.fullscreenQuadVS, shaderCodeNoRespawn, "fsQuad" + true);

        // Particle updater constants
        this.constantTexLifeAndSourcePosIN = gd.scope.resolve("texLifeAndSourcePosIN");
        this.constantTexLifeAndSourcePosOUT = gd.scope.resolve("texLifeAndSourcePosOUT");
        this.constantEmitterPos = gd.scope.resolve("emitterPos");
        this.constantBirthBounds = gd.scope.resolve("birthBounds");
        this.constantFrameRandom = gd.scope.resolve("frameRandom");
        this.constantDelta = gd.scope.resolve("delta");
        this.constantRate = gd.scope.resolve("rate");
        this.constantLifetime = gd.scope.resolve("lifetime");
        this.constantDeltaRnd = gd.scope.resolve("deltaRandomness");
        this.constantDeltaRndStatic = gd.scope.resolve("deltaRandomnessStatic");

        if (this.lighting) {
            this.constantLightCube = gd.scope.resolve("lightCube[0]");
        }

        this.numParticleVerts = this.mesh == undefined ? 4 : this.mesh.vertexBuffer.numVertices;
        this.numParticleIndices = this.mesh == undefined ? 6 : this.mesh.indexBuffer[0].numIndices;
        this.allocate(this.numParticles);

        var mesh = new pc.scene.Mesh();
        mesh.vertexBuffer = this.vertexBuffer;
        mesh.indexBuffer[0] = this.indexBuffer;
        mesh.primitive[0].type = pc.gfx.PRIMITIVE_TRIANGLES;
        mesh.primitive[0].base = 0;
        mesh.primitive[0].count = (this.numParticles * this.numParticleIndices);
        mesh.primitive[0].indexed = true;

        var hasNormal = ((this.textureNormal != null) || (this.textureNormalAsset != null));

        var programLib = this.graphicsDevice.getProgramLibrary();
        var normalOption = 0;
        if (this.lighting) {
            normalOption = hasNormal ? 2 : 1;
        }
        var isMesh = this.mesh != undefined;
        var shader = programLib.getProgram("particle2", {
            mode: this.mode,
            normal: normalOption,
            halflambert: this.softerLighting,
            stretch: this.stretch,
            soft: this.depthSoftening,
            mesh: isMesh,
            srgb: this.srgb,
            wrap: (this.wrapBounds != undefined)
        });
        var material = new pc.scene.Material();

        material.setShader(shader);
        material.setParameter('stretch', this.stretch);
        material.setParameter('colorMult', this.colorMult);
        if (this.mode == modeGPU) {
            material.setParameter('internalTex0', this.internalTex0);
            material.setParameter('internalTex1', this.internalTex1);
            material.setParameter('internalTex2', this.internalTex2);
            material.setParameter('texLifeAndSourcePosOUT', this.texLifeAndSourcePosOUT);
        }
        material.setParameter('internalTex3', this.internalTex3);

        material.setParameter('numParticles', this.numParticles);
        material.setParameter('lifetime', this.lifetime);
        material.setParameter('graphSampleSize', 1.0 / precision);
        material.setParameter('graphNumSamples', precision);
        if (this.wrapBounds != undefined) material.setParameter('wrapBounds', this.wrapBounds.data);
        //console.log(new pc.Vec3(this.birthBounds.x*0.5, this.birthBounds.y*0.5, this.birthBounds.z*0.5]);
        if (this.texture != null) material.setParameter('particleTexture', this.texture);
        if (this.lighting) {
            if (this.textureNormal != null) material.setParameter('normalTexture', this.textureNormal);
        }
        if (this.depthSoftening > 0) {
            material.setParameter('uDepthMap', this.camera.camera._depthTarget.colorBuffer);
            material.setParameter('screenSize', new pc.Vec4(gd.width, gd.height, 1.0 / gd.width, 1.0 / gd.height).data);
            material.setParameter('softening', this.depthSoftening);
        }

        material.cullMode = pc.gfx.CULLFACE_NONE;
        material.blend = true;

        // Premultiplied alpha. We can use it for both additive and alpha-transparent blending.
        material.blendSrc = pc.gfx.BLENDMODE_ONE;
        material.blendDst = pc.gfx.BLENDMODE_ONE_MINUS_SRC_ALPHA;

        if (this.stretch > 0.0) material.cull = pc.gfx.CULLFACE_NONE;

        material.depthWrite = this.ztest; //false;
        this.material = material;

        this.meshInstance = new pc.scene.MeshInstance(null, mesh, material);
        this.meshInstance.layer = pc.scene.LAYER_SKYBOX; //LAYER_FX;
        this.meshInstance.updateKey(); // shouldn't be here?

        this.addTime(0); // fill dynamic textures and constants with initial data

        this.endTime = CalcEndTime(this);
    };

    function CalcEndTime(emitter) {
        var interval = (emitter.rate * emitter.numParticles + emitter.lifetime + emitter.lifetime / (1 - emitter.deltaRandomnessStatic));
        interval = Math.min(interval, emitter.maxEmissionTime);
        return Date.now() + interval * 1000;
    }

    ParticleEmitter2.prototype = {

        // Declares vertex format, creates VB and IB
        allocate: function(numParticles) {
            var psysVertCount = numParticles * this.numParticleVerts;
            var psysIndexCount = numParticles * this.numParticleIndices;

            if ((this.vertexBuffer === undefined) || (this.vertexBuffer.getNumVertices() !== psysVertCount)) {
                // Create the particle vertex format
                if (this.mode == modeGPU) {
                    var elements = [{
                            semantic: pc.gfx.SEMANTIC_ATTR0,
                            components: 4,
                            type: pc.gfx.ELEMENTTYPE_FLOAT32
                        } // GPU: XYZ = quad vertex position; W = INT: particle ID, FRAC: random factor
                    ];
                    var particleFormat = new pc.gfx.VertexFormat(this.graphicsDevice, elements);

                    this.vertexBuffer = new pc.gfx.VertexBuffer(this.graphicsDevice, particleFormat, psysVertCount, pc.gfx.BUFFER_DYNAMIC);
                    this.indexBuffer = new pc.gfx.IndexBuffer(this.graphicsDevice, pc.gfx.INDEXFORMAT_UINT16, psysIndexCount);
                } else {
                    var elements = [{
                        semantic: pc.gfx.SEMANTIC_ATTR0,
                        components: 4,
                        type: pc.gfx.ELEMENTTYPE_FLOAT32
                    }, {
                        semantic: pc.gfx.SEMANTIC_ATTR1,
                        components: 4,
                        type: pc.gfx.ELEMENTTYPE_FLOAT32
                    }, {
                        semantic: pc.gfx.SEMANTIC_ATTR2,
                        components: 4,
                        type: pc.gfx.ELEMENTTYPE_FLOAT32
                    }];
                    var particleFormat = new pc.gfx.VertexFormat(this.graphicsDevice, elements);

                    this.vertexBuffer = new pc.gfx.VertexBuffer(this.graphicsDevice, particleFormat, psysVertCount, pc.gfx.BUFFER_DYNAMIC);
                    this.indexBuffer = new pc.gfx.IndexBuffer(this.graphicsDevice, pc.gfx.INDEXFORMAT_UINT16, psysIndexCount);
                }

                // Fill the vertex buffer
                var data = new Float32Array(this.vertexBuffer.lock());
                var meshData, stride;
                if (this.mesh != undefined) {
                    meshData = new Float32Array(this.mesh.vertexBuffer.lock());
                    stride = meshData.length / this.mesh.vertexBuffer.numVertices;
                }

                var rnd;
                for (var i = 0; i < psysVertCount; i++) {
                    if (i % this.numParticleVerts == 0) rnd = Math.random();
                    var id = Math.floor(i / this.numParticleVerts);

                    if (this.mesh == undefined) {
                        var vertID = i % 4;
                        data[i * 4] = particleVerts[vertID][0];
                        data[i * 4 + 1] = particleVerts[vertID][1];
                        data[i * 4 + 2] = 0;
                    } else {
                        var vert = i % this.numParticleVerts;
                        data[i * 4] = meshData[vert * stride];
                        data[i * 4 + 1] = meshData[vert * stride + 1];
                        data[i * 4 + 2] = meshData[vert * stride + 2];
                    }

                    data[i * 4 + 3] = id + rnd;
                }

                if (this.mode == modeCPU) this.vbCPU = new Float32Array(data);
                this.vertexBuffer.unlock();
                if (this.mesh != undefined) this.mesh.vertexBuffer.unlock();


                // Fill the index buffer
                var dst = 0;
                var indices = new Uint16Array(this.indexBuffer.lock());
                if (this.mesh != undefined) meshData = new Uint16Array(this.mesh.indexBuffer[0].lock());
                for (var i = 0; i < numParticles; i++) {
                    if (this.mesh == undefined) {
                        var baseIndex = i * 4;
                        indices[dst++] = baseIndex;
                        indices[dst++] = baseIndex + 1;
                        indices[dst++] = baseIndex + 2;
                        indices[dst++] = baseIndex;
                        indices[dst++] = baseIndex + 2;
                        indices[dst++] = baseIndex + 3;
                    } else {
                        for (var j = 0; j < this.numParticleIndices; j++) {
                            indices[i * this.numParticleIndices + j] = meshData[j] + i * this.numParticleVerts
                        }
                    }
                }
                this.indexBuffer.unlock();
                if (this.mesh != undefined) this.mesh.indexBuffer[0].unlock();
            }
        },

        Reset: function() {
            if (this.mode == modeCPU) {
                for (var i = 0; i < this.lifeAndSourcePosStart.length; i++) this.lifeAndSourcePos[i] = this.lifeAndSourcePosStart[i];
            } else {
                this.swapTex = false;
                var oldTexIN = this.texLifeAndSourcePosIN;
                this.texLifeAndSourcePosIN = this.texLifeAndSourcePosStart;
                this.addTime(0);
                this.texLifeAndSourcePosIN = oldTexIN;
            }
            this.endTime = CalcEndTime(this);
        },


        addTime: function(delta) {
            var device = this.graphicsDevice;
            device.setBlending(false);
            device.setColorWrite(true, true, true, true);
            device.setCullMode(pc.gfx.CULLFACE_NONE);
            device.setDepthTest(false);
            device.setDepthWrite(false);

            if ((this.texture == undefined) && (this.textureAsset != undefined)) {
                this.texture = this.textureAsset.resource;
                if (this.texture != undefined) {
                    this.material.setParameter('particleTexture', this.texture);
                    if ((!this.lighting) || (this.lighting && (this.textureNormal != undefined)) || (this.textureNormalAsset == undefined)) this.scene.addModel(this.psys);
                }
            }

            if (this.lighting) {
                if ((this.textureNormal == undefined) && (this.textureNormalAsset != undefined)) {
                    this.textureNormal = this.textureNormalAsset.resource;
                    if (this.textureNormal != undefined) {
                        this.material.setParameter('normalTexture', this.textureNormal);
                        if (this.texture != undefined) this.scene.addModel(this.psys);
                    }
                }
            }


            // Bake ambient and directional lighting into one ambient cube
            // TODO: only do if lighting changed
            if (this.lighting) {
                if (this.scene == undefined) {
                    console.error("There is no scene defined for lighting particles");
                    return;
                }

                for (var i = 0; i < 6; i++) {
                    this.lightCube[i * 3] = this.scene.ambientLight.r;
                    this.lightCube[i * 3 + 1] = this.scene.ambientLight.g;
                    this.lightCube[i * 3 + 2] = this.scene.ambientLight.b;
                }

                var dirs = this.scene._globalLights;
                for (var i = 0; i < dirs.length; i++) {
                    for (var c = 0; c < 6; c++) {
                        var weight = Math.max(this.lightCubeDir[c].dot(dirs[i]._direction), 0);
                        this.lightCube[c * 3] += dirs[i]._color.r * weight;
                        this.lightCube[c * 3 + 1] += dirs[i]._color.g * weight;
                        this.lightCube[c * 3 + 2] += dirs[i]._color.b * weight;
                    }
                }
                this.constantLightCube.setValue(this.lightCube);
            }

            if (this.mode == modeGPU) {
                this.frameRandom.x = Math.random();
                this.frameRandom.y = Math.random();
                this.frameRandom.z = Math.random();

                //return;
                this.constantEmitterPos.setValue(this.meshInstance.node == undefined ? (new pc.Vec3(0, 0, 0)).data : this.meshInstance.node.getPosition().data);
                this.constantBirthBounds.setValue(this.birthBounds.data);
                this.constantFrameRandom.setValue(this.frameRandom.data);
                this.constantDelta.setValue(delta);
                this.constantRate.setValue(this.rate);
                this.constantLifetime.setValue(this.lifetime);
                this.constantDeltaRnd.setValue(this.deltaRandomness);
                this.constantDeltaRndStatic.setValue(this.deltaRandomnessStatic);

                this.constantTexLifeAndSourcePosIN.setValue(this.swapTex ? this.texLifeAndSourcePosOUT : this.texLifeAndSourcePosIN);
                DrawQuadWithShader(device, this.swapTex ? this.rtLifeAndSourcePosIN : this.rtLifeAndSourcePosOUT, this.oneShot ? this.shaderParticleUpdateNoRespawn : this.shaderParticleUpdateRespawn);

                this.constantTexLifeAndSourcePosOUT.setValue(this.swapTex ? this.texLifeAndSourcePosIN : this.texLifeAndSourcePosOUT);
                this.swapTex = !this.swapTex;
            } else {
                // Particle updater emulation
                var emitterPos = this.meshInstance.node == undefined ? (new pc.Vec3(0, 0, 0)).data : this.meshInstance.node.getPosition().data;
                for (var i = 0; i < this.numParticles; i++) {
                    if (this.lifeAndSourcePos[i * 4 + 3] <= 0) {
                        this.lifeAndSourcePos[i * 4] = emitterPos[0] + this.birthBounds.x * this.particleNoize[i];
                        this.lifeAndSourcePos[i * 4 + 1] = emitterPos[1] + this.birthBounds.y * ((this.particleNoize[i] * 10) % 1);
                        this.lifeAndSourcePos[i * 4 + 2] = emitterPos[2] + this.birthBounds.z * ((this.particleNoize[i] * 100) % 1);
                    }
                    var x = i * (this.lifeAndSourcePos[i * 4 + 3] + this.lifeAndSourcePos[i * 4 + 0] + this.lifeAndSourcePos[i * 4 + 1] + this.lifeAndSourcePos[i * 4 + 2] + 1.0) * 1000.0;
                    x = (x % 13.0) * (x % 123.0);
                    var dx = (x % 0.01);
                    var noize = saturate(0.1 + dx * 100.0);
                    this.lifeAndSourcePos[i * 4 + 3] += delta * pc.math.lerp(1.0 - this.deltaRandomness, 1.0, noize) * pc.math.lerp(1.0 - this.deltaRandomnessStatic, 1.0, this.particleNoize[i]);

                    if (!this.oneShot) {
                        if (this.lifeAndSourcePos[i * 4 + 3] > this.lifetime) {
                            this.lifeAndSourcePos[i * 4 + 3] = -this.rate + (this.lifeAndSourcePos[i * 4 + 3] - this.lifetime);
                        }
                    }
                }

                var data = new Float32Array(this.vertexBuffer.lock());
                if (this.meshInstance.node != undefined) {
                    var fullMat = this.meshInstance.node.worldTransform;
                    for (var j = 0; j < 12; j++) rotMat.data[j] = fullMat.data[j];
                }


                // Particle sorting
                // TODO: optimize
                var posCam;
                posCam = camera.position.data;
                if (this.sort > 0) {
                    if (this.camera == undefined) {
                        console.error("There is no camera for particle sorting");
                        return;
                    }

                    for (var i = 0; i < this.numParticles; i++) {
                        this.vbToSort[i] = [i, Math.floor(this.vbCPU[i * this.numParticleVerts * 4 + 3])]; // particle id
                    }
                    for (var i = 0; i < this.numParticles * this.numParticleVerts * 4; i++) {
                        this.vbOld[i] = this.vbCPU[i];
                    }

                    var particleDistance = this.particleDistance;
                    this.vbToSort.sort(function(a, b) {
                        return particleDistance[a[1]] - particleDistance[b[1]];
                    });

                    for (var i = 0; i < this.numParticles; i++) {
                        var start = this.vbToSort[i][0];
                        for (var corner = 0; corner < this.numParticleVerts; corner++) {
                            for (var j = 0; j < 4; j++) {
                                this.vbCPU[i * this.numParticleVerts * 4 + corner * 4 + j] = this.vbOld[start * this.numParticleVerts * 4 + corner * 4 + j];
                            }
                        }
                    }
                }


                // Particle VS emulation
                for (var i = 0; i < this.numParticles; i++) {
                    var particleEnabled = true;
                    var particlePosX = 0.0;
                    var particlePosY = 0.0;
                    var particlePosZ = 0.0;
                    var particlePosPastX = 0.0;
                    var particlePosPastY = 0.0;
                    var particlePosPastZ = 0.0;
                    var origParticlePosX = 0.0;
                    var origParticlePosY = 0.0;
                    var origParticlePosZ = 0.0;
                    var particlePosMovedX = 0.0;
                    var particlePosMovedY = 0.0;
                    var particlePosMovedZ = 0.0;
                    var angle = 0.0;
                    var scale = 0.0;
                    var alphaRnd = 0.0;
                    var rndFactor = 0.0;
                    var sgn = 0.0;


                    var id = Math.floor(this.vbCPU[i * this.numParticleVerts * 4 + 3]);
                    var life = Math.max(this.lifeAndSourcePos[id * 4 + 3], 0) / this.lifetime;

                    if (this.lifeAndSourcePos[id * 4 + 3] < 0) particleEnabled = false;

                    if (particleEnabled) {
                        rndFactor = this.vbCPU[i * this.numParticleVerts * 4 + 3] % 1.0;

                        var rndFactor3X = rndFactor;
                        var rndFactor3Y = (rndFactor * 10) % 1;
                        var rndFactor3Z = (rndFactor * 100) % 1;

                        var sourcePosX = this.lifeAndSourcePos[id * 4];
                        var sourcePosY = this.lifeAndSourcePos[id * 4 + 1];
                        var sourcePosZ = this.lifeAndSourcePos[id * 4 + 2];


                        localOffsetVec.data = tex1D(this.qLocalOffset, life, 3, localOffsetVec.data);
                        var localOffset = localOffsetVec.data;
                        var posDivergence = tex1D(this.qPosDiv, life, 3);
                        var scaleRnd = tex1D(this.qScaleDiv, life);
                        var angleRnd = tex1D(this.qAngleDiv, life);
                        alphaRnd = tex1D(this.qAlphaDiv, life);

                        worldOffsetVec.data = tex1D(this.qWorldOffset, life, 3, worldOffsetVec.data, i == 0 ? 1 : 0);
                        var worldOffset = worldOffsetVec.data;
                        var posWorldDivergence = tex1D(this.qPosWorldDiv, life, 3);
                        angle = tex1D(this.qAngle, life);
                        scale = tex1D(this.qScale, life);

                        var divergentLocalOffsetX = pc.math.lerp(localOffset[0], -localOffset[0], rndFactor3X);
                        var divergentLocalOffsetY = pc.math.lerp(localOffset[1], -localOffset[1], rndFactor3Y);
                        var divergentLocalOffsetZ = pc.math.lerp(localOffset[2], -localOffset[2], rndFactor3Z);
                        localOffset[0] = pc.math.lerp(localOffset[0], divergentLocalOffsetX, posDivergence[0]);
                        localOffset[1] = pc.math.lerp(localOffset[1], divergentLocalOffsetY, posDivergence[1]);
                        localOffset[2] = pc.math.lerp(localOffset[2], divergentLocalOffsetZ, posDivergence[2]);

                        var divergentWorldOffsetX = pc.math.lerp(worldOffset[0], -worldOffset[0], rndFactor3X);
                        var divergentWorldOffsetY = pc.math.lerp(worldOffset[1], -worldOffset[1], rndFactor3Y);
                        var divergentWorldOffsetZ = pc.math.lerp(worldOffset[2], -worldOffset[2], rndFactor3Z);
                        worldOffset[0] = pc.math.lerp(worldOffset[0], divergentWorldOffsetX, posWorldDivergence[0]);
                        worldOffset[1] = pc.math.lerp(worldOffset[1], divergentWorldOffsetY, posWorldDivergence[1]);
                        worldOffset[2] = pc.math.lerp(worldOffset[2], divergentWorldOffsetZ, posWorldDivergence[2]);

                        angle = pc.math.lerp(angle, angle + 90 * rndFactor, angleRnd);
                        scale = pc.math.lerp(scale, scale * rndFactor, scaleRnd);

                        if (this.meshInstance.node != undefined) {
                            rotMat.transformPoint(localOffsetVec, localOffsetVec);
                        }

                        particlePosX = sourcePosX + localOffset[0] + worldOffset[0];
                        particlePosY = sourcePosY + localOffset[1] + worldOffset[1];
                        particlePosZ = sourcePosZ + localOffset[2] + worldOffset[2];

                        if (this.wrapBounds != undefined) {
                            origParticlePosX = particlePosX;
                            origParticlePosY = particlePosY;
                            origParticlePosZ = particlePosZ;
                            particlePosX -= posCam[0];
                            particlePosY -= posCam[1];
                            particlePosZ -= posCam[2];
                            particlePosX = glMod(particlePosX, this.wrapBounds.x * 2.0) - this.wrapBounds.x;
                            particlePosY = glMod(particlePosY, this.wrapBounds.y * 2.0) - this.wrapBounds.y;
                            particlePosZ = glMod(particlePosZ, this.wrapBounds.z * 2.0) - this.wrapBounds.z;
                            particlePosX += posCam[0];
                            particlePosY += posCam[1];
                            particlePosZ += posCam[2];
                            particlePosMovedX = particlePosX - origParticlePosX;
                            particlePosMovedY = particlePosY - origParticlePosY;
                            particlePosMovedZ = particlePosZ - origParticlePosZ;
                        }

                        if (this.sort == 1) {
                            this.particleDistance[id] = particlePosX * posCam[0] + particlePosY * posCam[1] + particlePosZ * posCam[2];
                        } else if (this.sort == 2) {
                            this.particleDistance[id] = life;
                        } else if (this.sort == 3) {
                            this.particleDistance[id] = -life;
                        }


                        if (this.stretch > 0.0) {
                            life = Math.max(life - (1.0 / this.precision) * this.stretch, 0.0);
                            localOffsetVec.data = tex1D(this.qLocalOffset, life, 3, localOffsetVec.data);
                            var localOffset = localOffsetVec.data;
                            var posDivergence = tex1D(this.qPosDiv, life, 3);

                            worldOffsetVec.data = tex1D(this.qWorldOffset, life, 3, worldOffsetVec.data, i == 0 ? 1 : 0);
                            worldOffset = worldOffsetVec.data;
                            posWorldDivergence = tex1D(this.qPosWorldDiv, life, 3);

                            divergentLocalOffsetX = pc.math.lerp(localOffset[0], -localOffset[0], rndFactor3X);
                            divergentLocalOffsetY = pc.math.lerp(localOffset[1], -localOffset[1], rndFactor3Y);
                            divergentLocalOffsetZ = pc.math.lerp(localOffset[2], -localOffset[2], rndFactor3Z);
                            localOffset[0] = pc.math.lerp(localOffset[0], divergentLocalOffsetX, posDivergence[0]);
                            localOffset[1] = pc.math.lerp(localOffset[1], divergentLocalOffsetY, posDivergence[1]);
                            localOffset[2] = pc.math.lerp(localOffset[2], divergentLocalOffsetZ, posDivergence[2]);

                            divergentWorldOffsetX = pc.math.lerp(worldOffset[0], -worldOffset[0], rndFactor3X);
                            divergentWorldOffsetY = pc.math.lerp(worldOffset[1], -worldOffset[1], rndFactor3Y);
                            divergentWorldOffsetZ = pc.math.lerp(worldOffset[2], -worldOffset[2], rndFactor3Z);
                            worldOffset[0] = pc.math.lerp(worldOffset[0], divergentWorldOffsetX, posWorldDivergence[0]);
                            worldOffset[1] = pc.math.lerp(worldOffset[1], divergentWorldOffsetY, posWorldDivergence[1]);
                            worldOffset[2] = pc.math.lerp(worldOffset[2], divergentWorldOffsetZ, posWorldDivergence[2]);

                            if (this.meshInstance.node != undefined) {
                                rotMat.transformPoint(localOffsetVec, localOffsetVec);
                            }

                            particlePosPastX = sourcePosX + localOffset[0] + worldOffset[0];
                            particlePosPastY = sourcePosY + localOffset[1] + worldOffset[1];
                            particlePosPastZ = sourcePosZ + localOffset[2] + worldOffset[2];
                            particlePosPastX += particlePosMovedX;
                            particlePosPastY += particlePosMovedY;
                            particlePosPastZ += particlePosMovedZ;

                            var moveDirX = particlePosX - particlePosPastX;
                            var moveDirY = particlePosY - particlePosPastY;
                            var moveDirZ = particlePosZ - particlePosPastZ;

                            sgn = (moveDirX > 0.0 ? 1.0 : -1.0) * (moveDirY > 0.0 ? 1.0 : -1.0) * (moveDirZ > 0.0 ? 1.0 : -1.0);
                        }
                    }


                    for (var v = 0; v < this.numParticleVerts; v++) {
                        var quadX = this.vbCPU[i * this.numParticleVerts * 4 + v * 4];
                        var quadY = this.vbCPU[i * this.numParticleVerts * 4 + v * 4 + 1];
                        var quadZ = this.vbCPU[i * this.numParticleVerts * 4 + v * 4 + 2];
                        if (!particleEnabled) {
                            quadX = quadY = quadZ = 0;
                        } else {
                            if (this.stretch > 0.0) {
                                var interpolation = quadY * 0.5 + 0.5;
                                //particlePosX = sgn > 0.0 ? pc.math.lerp(particlePosPastX, particlePosX, interpolation) : pc.math.lerp(particlePosX, particlePosPastX, interpolation);
                                //particlePosY = sgn > 0.0 ? pc.math.lerp(particlePosPastY, particlePosY, interpolation) : pc.math.lerp(particlePosY, particlePosPastY, interpolation);
                                //particlePosZ = sgn > 0.0 ? pc.math.lerp(particlePosPastZ, particlePosZ, interpolation) : pc.math.lerp(particlePosZ, particlePosPastZ, interpolation);

                                particlePosX = pc.math.lerp(particlePosX, particlePosPastX, interpolation);
                                particlePosY = pc.math.lerp(particlePosY, particlePosPastY, interpolation);
                                particlePosZ = pc.math.lerp(particlePosZ, particlePosPastZ, interpolation);
                            }
                        }

                        var w = i * this.numParticleVerts * 12 + v * 12;

                        data[w] = particlePosX;
                        data[w + 1] = particlePosY;
                        data[w + 2] = particlePosZ;
                        data[w + 3] = life;
                        data[w + 4] = angle;
                        data[w + 5] = scale;
                        data[w + 6] = alphaRnd * (((rndFactor * 1000.0) % 1) * 2.0 - 1.0);
                        //data[w+7] =   (quadX*0.5+0.5) + (quadY*0.5+0.5) * 0.1;
                        data[w + 8] = quadX;
                        data[w + 9] = quadY;
                        data[w + 10] = quadZ;
                    }
                }

                this.vertexBuffer.unlock();
            }

            if (this.oneShot) {
                if (this.onFinished != undefined) {
                    if (Date.now() > this.endTime) {
                        this.onFinished();
                    }
                }
            }

            device.setDepthTest(true);
            device.setDepthWrite(true);
        }
    };

    return {
        ParticleEmitter2: ParticleEmitter2,
        LinearGraph: LinearGraph
    };
}());
