const QuadShaderCanvas = require('./quadShaderCanvas.js');
const StateTransformer = require('./StateTransformer.js');
const CaveGenerator = require('./caveGenerator.js');
const AppState = require('./appState.js');
const Util = require('./util.js');

const THREE = require('three');
const vec2 = THREE.Vector2;

const Y_HISTORY_LENGTH = 1000;
const CAVE_SAMPLE_DIST = 8;
const WORM_BLOCK_SPACING = 80;

class GameStateTransformer extends StateTransformer {
	setUp() {
		this.state = {
			time: 0,
			player: {position: new vec2(),
					 velocity: new vec2(),
					 rotation: 0,
					 mass: 10,
					 activeForces: [],
					 dying: false,
					 dead: false,
					 velocityCap: new vec2(12, 20),
					}, 
			camera: {position: new vec2(),
					 velocity: new vec2(),
					 activeForces: [],
					 mass: 2,
					 velocityCap: new vec2(20, 60),
					},
			keyStates: {},
			playerYHistory: [],
			yHistoryIndex: 0,
		};

		const uniforms = {playerPos: {value: this.state.player.position},
						  cameraPos: {value: this.state.camera.position},
						  wormData: {value: new Float32Array(16)},
						  wormData2: {value: new Float32Array(16)},};

		this.quadShaderCanvas = new QuadShaderCanvas('canvas-container', this.getFragmentShader(), uniforms);

		this.caveHeightTex = this.getCaveDataTexture();
		this.quadShaderCanvas.uniforms['caveHeights'] = {type: "t", value: this.caveHeightTex};

		this.state.player.position = this.getInitialPlayerPosition();
		this.state.camera.position = Util.toMetersV(new vec2(AppState.canvasWidth/2,
															 AppState.canvasHeight/2));

		this.setUpBrowserInputHandlers();

		this.caveGenerator = new CaveGenerator();
	}

	handleEvent(event) {}

	update(time, deltaTime) {
		// generate coins routine
		// general cleanup routine

		if (this.focused) {
			this.assignEnvironmentalForces();

			this.findCollisions().forEach(collisionEvent => EventQueue.push(collisionEvent));

			this.updateKinematics(deltaTime);

			this.updateCaveGeometry();

			this.updateWorm();

			// Convert to seconds
			this.state.time = time / 1000;

			this.mapStateToUniforms(this.state);
		}
	}

	updateKinematics(deltaTime) {
		const entities = [this.state.player, this.state.camera];

		entities.forEach(entity => {
			if (entity === this.state.camera) {
				const target = this.state.player.position.clone().add(new vec2(10, 0));
				entity.position.addScaledVector(target.sub(this.state.camera.position), 
												1 / 10);
			} else {
				const totalForce = new vec2();
				entity.activeForces.forEach(force => {
					totalForce.add(force);
				});

				const acceleration = new vec2(totalForce.x / entity.mass, totalForce.y / entity.mass);
				const velocity = entity.velocity;

				velocity.addScaledVector(acceleration, deltaTime);

				// Cap velocity
				velocity.x = Math.min(Math.abs(velocity.x), Math.abs(entity.velocityCap.x)) * ((velocity.x + 1) / Math.abs(velocity.x + 1));
				// velocity.y = Math.min(Math.abs(velocity.y), Math.abs(entity.velocityCap.y)) * ((velocity.y + 1) / Math.abs(velocity.y + 1));

				entity.position.addScaledVector(velocity, deltaTime);
			}

			entity.activeForces.length = 0;
		});
	}

	updateWorm() {
		const playerPosInPixels = this.cameraTransform(this.state.player.position);

		this.updatePlayerYHistory(playerPosInPixels);
	}

	updatePlayerYHistory(playerPosInPixels) {
		const state = this.state;
		const newYHistoryIndex = Math.floor(playerPosInPixels.x) % Y_HISTORY_LENGTH;

		if (state.yHistoryIndex > newYHistoryIndex) {
			for (let i = state.yHistoryIndex; i < state.playerYHistory.length; i++) {
				state.playerYHistory[i] = playerPosInPixels.y;
			}
			for (let i = 0; i <= newYHistoryIndex; i++) {
				state.playerYHistory[i] = playerPosInPixels.y;
			}
		} else {
			for (let i = state.yHistoryIndex; i <= newYHistoryIndex; i++) {
				state.playerYHistory[i] = playerPosInPixels.y;
			}
		}
		state.yHistoryIndex = newYHistoryIndex;
	}

	assignEnvironmentalForces() {
		const player = this.state.player;
		const camera = this.state.camera;

		const gravityConstant = 6.673e-11;
		const earthMass = 5.98e24;
		const earthRadius = 6.38e6;
		const gravityForceMagnitude = (gravityConstant * earthMass * player.mass) / 6.38e6 ** 2;

		// Weaken gravity and thrust for the first few seconds
		const introScale = Util.smoothstep(0, 3, this.state.time);

		player.activeForces.push(new vec2(0, -gravityForceMagnitude * 2 * introScale));

		player.activeForces.push(new vec2(80, 0));

		if (this.state.keyStates.ArrowUp) {
			player.activeForces.push(new vec2(0, 500 * introScale));			
		}
	}

	updateCaveGeometry() {
		const camX = Math.floor(Util.toPixels(this.state.camera.position.x)) - Math.floor(AppState.canvasWidth / 2);
		const texelCount = AppState.canvasWidth / (CAVE_SAMPLE_DIST / window.devicePixelRatio);

		for (let i = 0; i < texelCount; i++) {
			const y = this.caveGenerator.getTopSurfaceY(i*CAVE_SAMPLE_DIST + camX);
			this.caveHeightTex.image.data[i] = Util.toPixels(y);
		}

		this.caveHeightTex.needsUpdate = true;
	}

	mapStateToUniforms(state) {
		const playerPos = this.cameraTransform(state.player.position);
		const cameraPos = this.cameraTransform(state.camera.position);

		this.quadShaderCanvas.uniforms.time.value = state.time;
		this.quadShaderCanvas.uniforms.playerPos.value = playerPos;
		this.quadShaderCanvas.uniforms.cameraPos.value = cameraPos;

		// Update trailing worm block positions
		// and copy into matrix uniforms
		for (let i = 0; i < 6; i++) {
			const playerPosClone = playerPos.clone();
			playerPosClone.x += -WORM_BLOCK_SPACING * i;
			playerPosClone.y = this.getPastPlayerY(playerPosClone.x);
			this.setWormPartData(playerPosClone, 0, i);
		}
	}

	setWormPartData(position, rotation, index) {
		if (index < 4) {
			const i = index * 4;
			const wormData = this.quadShaderCanvas.uniforms.wormData;
			wormData.value[i + 0] = position.x;
			wormData.value[i + 1] = position.y;
			wormData.value[i + 2] = rotation;
		} else {
			const i = (index - 4) * 4;
			const wormData = this.quadShaderCanvas.uniforms.wormData2;
			wormData.value[i + 0] = position.x;
			wormData.value[i + 1] = position.y;
			wormData.value[i + 2] = rotation;
		}
	}

	cameraTransform(vec) {
		return Util.toPixelsV(vec);
	}

	// Previous y position of worm head segment in pixels
	getPastPlayerY(x) {
		const i = Math.floor(x) % Y_HISTORY_LENGTH;
		const y = this.state.playerYHistory[i];

		if (isNaN(y)) {
			return Util.toPixels(this.getInitialPlayerPosition().y);
		} else {
			return y;
		}
	}

	findCollisions() {
		return [];
	}

	render() {
		this.quadShaderCanvas.render();
	}

	getFragmentShader() {
		const fs = `
			precision highp float;

			uniform vec2 resolution;
			uniform vec2 playerPos;
			uniform vec2 cameraPos;
			uniform float time;
			uniform mat4 wormData;
			uniform mat4 wormData2;
			uniform sampler2D caveHeights;

			float beat(float value, float intensity, float frequency) {
			  float v = atan(sin(value * 3.145 * frequency) * intensity);
			  return (v + 3.145 / 2.) / 3.145;
			}

			// Maximum/minumum elements of a vector
			float vmax(vec2 v) {
				return max(v.x, v.y);
			}

			float fBox2Cheap(vec2 p, vec2 b) {
				return vmax(abs(p)-b);
			}

			// Similar to fOpUnionRound, but more lipschitz-y at acute angles
			// (and less so at 90 degrees). Useful when fudging around too much
			// by MediaMolecule, from Alex Evans' siggraph slides
			// http://mercury.sexy/hg_sdf/
			float fOpUnionSoft(float a, float b, float r) {
				float e = max(r - abs(a - b), 0.);
				return min(a, b) - e*e*0.25/r;
			}

			// https://www.shadertoy.com/view/Msf3WH
			vec2 hash( vec2 p ) {
			  p = vec2( dot(p,vec2(127.1,311.7)),
			        dot(p,vec2(269.5,183.3)) );

			  return -1.0 + 2.0*fract(sin(p)*43758.5453123);
			}

			// Simplex noise from https://www.shadertoy.com/view/Msf3WH
			float noise( in vec2 p ) {
			  const float K1 = 0.366025404; // (sqrt(3)-1)/2;
			  const float K2 = 0.211324865; // (3-sqrt(3))/6;

			  vec2 i = floor( p + (p.x+p.y)*K1 );
			  
			  vec2 a = p - i + (i.x+i.y)*K2;
			  vec2 o = step(a.yx,a.xy);    
			  vec2 b = a - o + K2;
			  vec2 c = a - 1.0 + 2.0*K2;

			  vec3 h = max( 0.5-vec3(dot(a,a), dot(b,b), dot(c,c) ), 0.0 );

			  vec3 n = h*h*h*h*vec3( dot(a,hash(i+0.0)), dot(b,hash(i+o)), dot(c,hash(i+1.0)));

			  return dot( n, vec3(70.0) );
			}

			// unsigned round box
			// http://mercury.sexy/hg_sdf/
			float udRoundBox( vec2 p, vec2 b, float r )
			{
			  return length(max(abs(p)-b,0.0))-r;
			}

			vec4 bgColor(vec2 uv) {
				float theNoise = noise((uv * 25.));
				float noise = (theNoise * theNoise) / 2. / 2.5;
				return vec4(0., noise * 1.1, noise * 2., 1.0);	
			}

			float coolWormNoise(vec2 uv) {
				vec2 uv1 = vec2(uv.x + 1., uv.y);
				float noise1 = noise((uv1 * 10.));
				vec2 uv2 = vec2(uv.x - 1., uv.y);
				float noise2 = noise((uv2 * 10.));
				vec2 uv3 = vec2(uv.x, uv.y + 1.);
				float noise3 = noise((uv3 * 10.));
				vec2 uv4 = vec2(uv.x, uv.y - 1.);
				float noise4 = noise((uv4 * 10.));

				return (noise1 + noise2 + noise3 + noise4) / 3.;
			}

			float wormDist(vec2 coord, vec2 boxSize, float cornerRadius) {
				float dist1 = udRoundBox(coord - wormData[0].xy, boxSize, cornerRadius);
				float dist2 = udRoundBox(coord - wormData[1].xy, boxSize, cornerRadius);
				float dist3 = udRoundBox(coord - wormData[2].xy, boxSize, cornerRadius);
				float dist4 = udRoundBox(coord - wormData[3].xy, boxSize, cornerRadius);
				float dist5 = udRoundBox(coord - wormData2[0].xy, boxSize, cornerRadius);
				float dist6 = udRoundBox(coord - wormData2[1].xy, boxSize, cornerRadius);

				float radius = 80.;

				float wormDataUnion = fOpUnionSoft(fOpUnionSoft(fOpUnionSoft(dist1, dist2, radius), dist3, radius), dist4, radius);
				float wormData2Union = fOpUnionSoft(dist5, dist6, radius);

				return fOpUnionSoft(wormDataUnion, wormData2Union, radius);
			}

			vec4 getWormBlockColor(vec2 coord, vec2 uv, vec2 bgUV) {
				float sideLength = 30.;
				float cornerRadius = 15.;
				float dist = wormDist(coord, vec2(sideLength, sideLength), cornerRadius) / (sideLength + cornerRadius);

				if (dist < 0.3) {
					float borderMod = smoothstep(0.15, 0.3, dist) / 3.;
					float brighten = -dist / 2. + borderMod;			

					float r = brighten;
					float g = (sin(time) + 1.) / 2. * 0.2 + brighten;
					float b = (cos(time) + 1.) / 2. * 0.2 + brighten;

					float c = coolWormNoise(bgUV);

					return vec4(r + c, g, b, 1.0);	
				} else {
					return vec4(0);
				}
			}

			vec4 getWormColor(vec2 coord, vec2 uv, vec2 bgUV) {
				vec4 color = getWormBlockColor(coord, uv, bgUV);

				if (length(color) > 0.) {
					return color;
				}

				return vec4(0);
			}

			// https://www.shadertoy.com/view/Msf3WH
			float fractalNoise(vec2 uv) {
				float f = 0.;
		        mat2 m = mat2( 1.6,  1.2, -1.2,  1.6 );
				f  = 0.5000*noise( uv ); uv = m*uv;
				f += 0.2500*noise( uv ); uv = m*uv;
				f += 0.1250*noise( uv ); uv = m*uv;
				f += 0.0625*noise( uv ); uv = m*uv;

				return f;
			}

			void main(void) {
				vec2 bgCoord = (gl_FragCoord.xy + (cameraPos.xy * 0.5 - (resolution.xy / 2.)));
				vec2 bgP = bgCoord / resolution.xy;
				vec2 bgUV = bgP * vec2(resolution.x/resolution.y,1.0);

				vec2 coord = gl_FragCoord.xy + (cameraPos.xy - (resolution.xy / 2.));
				vec2 p = coord / resolution.xy;
				vec2 movingUV = p * vec2(resolution.x/resolution.y,1.0);

				vec2 screenP = gl_FragCoord.xy / resolution.xy;
				vec2 uv = screenP * vec2(resolution.x/resolution.y,1.0);

				vec4 wormColor = getWormColor(coord, movingUV, bgUV);

				if (length(wormColor) > 0.) {
					gl_FragColor = wormColor;
				}
				else {
					float height = texture2D(caveHeights, vec2(uv.x / 2., 0.)).a;
					float dist = coord.y - height;

					if (coord.y > height || coord.y < height - 800.) {
						if (coord.y < height - 800.) {
							dist = height - 800. - coord.y;
						}

						float glow = (1. - smoothstep(0., 50., dist)) * 0.8;
						gl_FragColor = vec4(glow, 0.2 - (glow * 0.1), 0.45 - (glow * 0.22), 1.0);
					} else {
						gl_FragColor = bgColor(bgUV);
					}					
				}
				
			}
		`;

		return fs;
	}

	getInitialPlayerPosition() {
		return Util.toMetersV(new vec2(AppState.canvasWidth * 0.1,
												AppState.canvasHeight / 4));
	}

	getCaveDataTexture() {
		return new THREE.DataTexture(new Float32Array(AppState.canvasWidth/CAVE_SAMPLE_DIST),
														   AppState.canvasWidth/CAVE_SAMPLE_DIST,
														   1,
														   THREE.AlphaFormat,
														   THREE.FloatType,
														   THREE.UVMapping,
														   THREE.ClampWrapping,
														   THREE.ClampWrapping,
														   THREE.LinearFilter,
														   THREE.LinearFilter,
														   1);
	}

	setUpBrowserInputHandlers() {
		const canvas = this.quadShaderCanvas.renderer.domElement;
		canvas.tabIndex = 0;
		canvas.focus();
		canvas.style.outline = 'none';

		canvas.addEventListener('keydown', (e) => {
			this.state.keyStates[e.key] = true;
		});
		canvas.addEventListener('keyup', (e) => {
			this.state.keyStates[e.key] = false;
		});

		this.focused = true;

		canvas.addEventListener('blur', (e) => {
			this.focused = false;
		});
		canvas.addEventListener('focus', (e) => {
			this.focused = true;
		});
	}

	tearDown() {}
}

module.exports = GameStateTransformer;