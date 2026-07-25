const VAT_WIDTH = 60;
const CORNER_COUNT = 3072;
const POSITION_COUNT = 532;
const MATERIAL_FRAME_COUNT = 240;
const GAME_FPS = 60;

const VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform highp usampler2D u_vfi;
uniform highp usampler2D u_vfp;
uniform vec2 u_resolution;
uniform vec2 u_iconCenter;
uniform vec3 u_rotation;
uniform float u_vatPosition;
uniform float u_iconScale;

out vec3 v_worldPosition;
out vec3 v_worldNormal;

const float NEAR_PLANE = 0.01;
const float FAR_PLANE = 1000.0;

vec3 rotateX(vec3 point, float angle) {
  float sine = sin(angle);
  float cosine = cos(angle);
  return vec3(
    point.x,
    cosine * point.y - sine * point.z,
    sine * point.y + cosine * point.z
  );
}

vec3 rotateY(vec3 point, float angle) {
  float sine = sin(angle);
  float cosine = cos(angle);
  return vec3(
    cosine * point.x + sine * point.z,
    point.y,
    -sine * point.x + cosine * point.z
  );
}

vec3 rotateZ(vec3 point, float angle) {
  float sine = sin(angle);
  float cosine = cos(angle);
  return vec3(
    cosine * point.x - sine * point.y,
    sine * point.x + cosine * point.y,
    point.z
  );
}

vec3 decodePosition(uvec4 packedPosition) {
  vec2 xy = unpackHalf2x16(packedPosition.x | (packedPosition.y << 16u));
  vec2 zw = unpackHalf2x16(packedPosition.z | (packedPosition.w << 16u));
  return vec3(xy, zw.x);
}

vec3 decodeNormal(uint encodedNormal) {
  int normalIndex = encodedNormal < 0x8000u
    ? int(encodedNormal) + 29695
    : 64511 - int(encodedNormal);
  float indexValue = float(normalIndex);
  float azimuth = indexValue * 3.88322115;
  float vertical = indexValue * -0.000032553144 + 0.999983728;
  float absoluteVertical = abs(vertical);
  float polar = (((absoluteVertical * -0.0187293 + 0.0742610022) *
    absoluteVertical - 0.2121144) * absoluteVertical + 1.5707288) *
    sqrt(max(0.0, 1.0 - absoluteVertical));
  if (vertical < 0.0) polar = 3.1415927 - polar;
  float radius = sin(polar);
  return vec3(
    radius * cos(azimuth),
    vertical,
    radius * sin(azimuth)
  );
}

void main() {
  int vatVertex = gl_VertexID;
  int vatColumn = min(
    int(floor(fract(u_vatPosition) * float(${VAT_WIDTH}))),
    ${VAT_WIDTH - 1}
  );
  uint positionRow = texelFetch(u_vfi, ivec2(vatColumn, vatVertex), 0).r;
  uvec4 packedPosition = texelFetch(
    u_vfp,
    ivec2(vatColumn, int(positionRow)),
    0
  );

  vec3 worldPosition = decodePosition(packedPosition);
  vec3 worldNormal = decodeNormal(packedPosition.w);
  worldPosition = rotateX(worldPosition, u_rotation.x);
  worldPosition = rotateY(worldPosition, u_rotation.y);
  worldPosition = rotateZ(worldPosition, u_rotation.z);
  worldNormal = rotateX(worldNormal, u_rotation.x);
  worldNormal = rotateY(worldNormal, u_rotation.y);
  worldNormal = rotateZ(worldNormal, u_rotation.z);
  v_worldPosition = worldPosition;
  v_worldNormal = normalize(worldNormal);

  float cameraDepth = max(0.001, 1.0 - worldPosition.z);
  vec2 centerNdc = u_iconCenter / u_resolution * 2.0 - 1.0;
  vec2 modelToNdc = vec2(
    2.0 * u_iconScale / u_resolution.x,
    2.0 * u_iconScale / u_resolution.y
  );
  float depthA = (FAR_PLANE + NEAR_PLANE) / (FAR_PLANE - NEAR_PLANE);
  float depthB = (2.0 * FAR_PLANE * NEAR_PLANE) / (FAR_PLANE - NEAR_PLANE);
  gl_Position = vec4(
    centerNdc * cameraDepth + worldPosition.xy * modelToNdc,
    depthA * cameraDepth - depthB,
    cameraDepth
  );
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec3 u_albedo;
uniform vec3 u_transmission;

in vec3 v_worldPosition;
in vec3 v_worldNormal;
out vec4 outColor;

const float ROUGHNESS = 0.15;
const float LIGHT_INTENSITY = 6.25;
const float TRANSMISSION_RATE = 0.234;
const float SCATTERING_RATE = 0.6;
const float EDGE_TRANSMISSION_POWER = 3.2;
const vec3 LIGHT_DIRECTION = vec3(0.6913417, -0.5555702, -0.4619398);

vec3 linearToSrgb(vec3 linearColor) {
  vec3 low = linearColor * 12.92;
  vec3 high = 1.055 * pow(max(linearColor, 0.0), vec3(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(vec3(0.0031308), linearColor));
}

void main() {
  vec3 viewDirection = normalize(vec3(0.0, 0.0, 1.0) - v_worldPosition);
  vec3 normal = normalize(v_worldNormal);
  vec3 lightDirection = normalize(-LIGHT_DIRECTION);
  vec3 halfway = normalize(lightDirection + viewDirection);
  float nDotL = dot(normal, lightDirection);
  float nDotV = dot(normal, viewDirection);
  float vDotH = max(dot(viewDirection, halfway), 0.00000001);
  float nDotH = max(dot(normal, halfway), 0.00000001);
  float nDotH2 = nDotH * nDotH;
  float roughness = max(ROUGHNESS, 0.0001);
  float roughness2 = roughness * roughness;
  float roughness4 = roughness2 * roughness2;
  float k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  float visibilityView = 1.0 / (k + nDotV * (1.0 - k));
  float visibilityLight = 1.0 /
    (k + max(nDotL, 0.00000001) * (1.0 - k));
  float distributionDenominator = max(
    1.0 + nDotH2 * (roughness4 - 1.0),
    0.00000001
  );
  float distributionVisibility = visibilityView * visibilityLight *
    roughness4 /
    (distributionDenominator * distributionDenominator);
  float fresnelFactor = exp2(
    vDotH * (-5.55473 * vDotH - 6.98316002)
  );
  vec3 fresnel = vec3(0.04) + vec3(0.96) * fresnelFactor;
  vec3 directBrdf = distributionVisibility * fresnel * 0.07957747 +
    u_albedo * 0.318309873;
  vec3 direct = directBrdf * clamp(nDotL, 0.0, 1.0) * LIGHT_INTENSITY;
  float viewAgainstLight = clamp(
    dot(viewDirection, -lightDirection),
    0.001,
    1.0
  );
  float scatteringWeight = (SCATTERING_RATE - 1.0) *
    (SCATTERING_RATE - 1.0);
  float scattering = 0.2 + scatteringWeight *
    (pow(viewAgainstLight, 1.0 / SCATTERING_RATE) - 0.2);
  float backFacingLight = max(-dot(normal, lightDirection), 0.0);
  float transmissionEdge = pow(
    clamp(1.0 - nDotV * backFacingLight, 0.0, 1.0),
    EDGE_TRANSMISSION_POWER
  );
  vec3 transmitted = u_albedo * u_transmission * TRANSMISSION_RATE *
    scattering * transmissionEdge * LIGHT_INTENSITY;
  vec3 ambient = u_albedo * 0.085;
  vec3 linearColor = ambient + direct * (1.0 - TRANSMISSION_RATE) + transmitted;
  outColor = vec4(linearToSrgb(linearColor), 1.0);
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not create a WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Shader compilation failed";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) throw new Error("Could not create the WebGL program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "WebGL linking failed";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function requireUniform(gl, program, name) {
  const location = gl.getUniformLocation(program, name);
  if (location === null) throw new Error(`Missing shader uniform ${name}`);
  return location;
}

function decodeTexture(value, expectedBytes, name) {
  let data;
  if (value instanceof Uint16Array) {
    data = value;
  } else if (value instanceof ArrayBuffer) {
    data = new Uint16Array(value);
  } else if (typeof value === "string") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    data = new Uint16Array(bytes.buffer);
  } else {
    throw new Error(`Invalid ${name} texture`);
  }
  if (data.byteLength !== expectedBytes) {
    throw new Error(`Invalid ${name} texture`);
  }
  return data;
}

function loadAssets(source) {
  if (!source || !source.curves) {
    throw new Error("LoadingIcon assets are required");
  }
  return {
    curves: source.curves,
    vfi: decodeTexture(
      source.vfi,
      VAT_WIDTH * CORNER_COUNT * 2,
      "LoadingIcon Vfi",
    ),
    vfp: decodeTexture(
      source.vfp,
      VAT_WIDTH * POSITION_COUNT * 8,
      "LoadingIcon Vfp",
    ),
  };
}

function createIntegerTexture(gl, width, height, internalFormat, format, data) {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Could not create a VAT texture");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    internalFormat,
    width,
    height,
    0,
    format,
    gl.UNSIGNED_SHORT,
    data,
  );
  return texture;
}

function evaluateCurve(curve, frame) {
  let keyIndex = 0;
  for (let index = 1; index < curve.keys.length; index += 1) {
    if (curve.keys[index].frame > frame) break;
    keyIndex = index;
  }
  const key = curve.keys[keyIndex];
  const next = curve.keys[Math.min(keyIndex + 1, curve.keys.length - 1)];
  const duration = next.frame - key.frame;
  const t = duration > 0 ? (frame - key.frame) / duration : 0;
  const raw = key.raw;
  if (curve.type === "Cubic") {
    return (
      (raw[0] + raw[1] * t + raw[2] * t * t + raw[3] * t * t * t) *
        curve.scale +
      curve.offset
    );
  }
  return (raw[0] + raw[1] * t) * curve.scale + curve.offset;
}

function findParam(curves, name) {
  const param = curves.params.find((candidate) => candidate.name === name);
  if (!param) throw new Error(`LoadingIcon_00 is missing ${name}`);
  return param;
}

function evaluateColor(param, frame) {
  return param.curves
    .slice(0, 3)
    .map((curve) => evaluateCurve(curve, frame));
}

function gameRotation(frame) {
  const phase = (frame % 360) / 360;
  const roundFactor = phase < 0.5 ? phase - 1 : 1 - phase;
  return [
    20 * roundFactor,
    frame * 0.6000000238418579 + 45 * roundFactor,
    0,
  ].map((value) => (value * Math.PI) / 180);
}

function startInkLoadingAnimation(
  canvas,
  source = globalThis.InkLoadingAnimationAssets,
) {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    depth: true,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error("WebGL 2 is required");

  const assets = loadAssets(source);
  const program = createProgram(gl);
  const vao = gl.createVertexArray();
  if (!vao) throw new Error("Could not create the vertex array");

  const vfiTexture = createIntegerTexture(
    gl,
    VAT_WIDTH,
    CORNER_COUNT,
    gl.R16UI,
    gl.RED_INTEGER,
    assets.vfi,
  );
  const vfpTexture = createIntegerTexture(
    gl,
    VAT_WIDTH,
    POSITION_COUNT,
    gl.RGBA16UI,
    gl.RGBA_INTEGER,
    assets.vfp,
  );
  const uniforms = {
    resolution: requireUniform(gl, program, "u_resolution"),
    iconCenter: requireUniform(gl, program, "u_iconCenter"),
    rotation: requireUniform(gl, program, "u_rotation"),
    vatPosition: requireUniform(gl, program, "u_vatPosition"),
    iconScale: requireUniform(gl, program, "u_iconScale"),
    albedo: requireUniform(gl, program, "u_albedo"),
    transmission: requireUniform(gl, program, "u_transmission"),
    vfi: requireUniform(gl, program, "u_vfi"),
    vfp: requireUniform(gl, program, "u_vfp"),
  };
  const albedoParam = findParam(assets.curves, "albedo_color");
  const transmissionParam = findParam(
    assets.curves,
    "transmission_color_backlight",
  );
  const vatParam = findParam(assets.curves, "vat_anim_pos");

  gl.useProgram(program);
  gl.uniform1i(uniforms.vfi, 0);
  gl.uniform1i(uniforms.vfp, 1);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.BLEND);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.frontFace(gl.CCW);
  gl.clearColor(0, 0, 0, 0);

  let active = true;
  let animationFrame = 0;
  let elapsed = 0;
  let previousTimestamp = performance.now();

  const draw = (timestamp) => {
    if (!active) return;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const logicalWidth = canvas.clientWidth || canvas.width || 192;
    const logicalHeight = canvas.clientHeight || canvas.height || 192;
    const width = Math.max(1, Math.round(logicalWidth * pixelRatio));
    const height = Math.max(1, Math.round(logicalHeight * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);

    const delta = Math.min((timestamp - previousTimestamp) / 1000, 0.05);
    previousTimestamp = timestamp;
    elapsed += delta;
    const absoluteFrame = Math.floor(elapsed * GAME_FPS);
    const materialFrame = absoluteFrame % MATERIAL_FRAME_COUNT;
    const rotation = gameRotation(absoluteFrame);
    const albedo = evaluateColor(albedoParam, materialFrame);
    const transmission = evaluateColor(transmissionParam, materialFrame);
    const vatPosition = evaluateCurve(vatParam.curves[0], materialFrame);

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, vfiTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, vfpTexture);
    gl.uniform2f(uniforms.resolution, width, height);
    gl.uniform2f(uniforms.iconCenter, width / 2, height / 2);
    gl.uniform3f(uniforms.rotation, rotation[0], rotation[1], rotation[2]);
    gl.uniform1f(uniforms.vatPosition, vatPosition);
    gl.uniform1f(uniforms.iconScale, 154.5096679918781 * pixelRatio);
    gl.uniform3f(uniforms.albedo, albedo[0], albedo[1], albedo[2]);
    gl.uniform3f(
      uniforms.transmission,
      transmission[0],
      transmission[1],
      transmission[2],
    );
    gl.drawArrays(gl.TRIANGLES, 0, CORNER_COUNT);
    animationFrame = requestAnimationFrame(draw);
  };

  animationFrame = requestAnimationFrame(draw);

  return () => {
    active = false;
    cancelAnimationFrame(animationFrame);
    gl.deleteTexture(vfiTexture);
    gl.deleteTexture(vfpTexture);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
  };
}

globalThis.startInkLoadingAnimation = startInkLoadingAnimation;
