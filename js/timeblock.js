/* Nolfe — time block (production viewer from the live Wix embed, adapted for the entrance).
   Source of truth: https://www-nolfemedia-com.filesusr.com/html/d630c3_09a75ecb50def8d1ba08016f6343b6e3.html
   Every behavioural change from production is marked [intro]. Outside the crossing, the camera,
   shader, plane layout, opacity rules, HD frames, glide, keys and chrome behave exactly as before. */
(function () {
'use strict';
const Entry = window.NolfeEntry;                                                   // [intro]
// [intro] Frames are served one by one: cut losslessly (jpegtran, pixel-identical) from the production sprite sheets
// and hosted with the intro (intro/tb/t = 640x480, intro/tb/h = 1280x960 sharp). Showing a frame now decodes ~1.2 MB
// (sharp ~4.9 MB) instead of a whole 3840x3840 sprite sheet (~59 MB), which is what closed the page on iPhones. Decoded
// frames are drawn into the same cut canvas as before and released at once, so the GPU sees exactly what it always did.
const N=1222,FW=640,FH=480;
// Phones and tablets (coarse pointer) count GPU memory against the page's own budget: fewer textures, no antialiasing.
const COARSE=matchMedia('(pointer:coarse)').matches;
const HW=1280,HH=960,HD_KEEP=COARSE?8:12,TEX_CAP=COARSE?96:180;
const frameUrl=(n,sharp)=>((window.NOLFE_INTRO_CONFIG||{}).base||'intro/')+'tb/'+(sharp?'h/':'t/')+String(n).padStart(4,'0')+'.jpg';
// [intro] Fast scrolling on iPhone: a download for a frame the view has already left is cancelled so it doesn't hold a
// slot, and a failed one is retried instead of staying blank. Frames decode to ImageBitmaps closed right after upload
// (an <img> + decode() version kept twice the memory).
function decodeFrame(url,ctl){
  if(!window.createImageBitmap)return new Promise((ok,no)=>{const im=new Image();im.crossOrigin='anonymous';
    if(ctl)ctl.cancel=()=>{im.onload=im.onerror=null;im.removeAttribute('src');no(Error('cancelled'))};
    im.onload=()=>ok(im);im.onerror=()=>no(Error('failed'));im.src=url});
  const ac=window.AbortController?new AbortController():null;if(ctl&&ac)ctl.cancel=()=>ac.abort();
  return fetch(url,{mode:'cors',signal:ac?ac.signal:undefined}).then(r=>{if(!r.ok)throw Error('failed');return r.blob()}).then(b=>createImageBitmap(b))
    .catch(e=>{throw e&&e.name==='AbortError'?Error('cancelled'):e})}
const freeFrame=im=>{if(!im)return;if(im.close)im.close();else{im.onload=im.onerror=null;im.removeAttribute('src')}};
const LOAD_MAX=12,HD_MAX=3,pendingCtl=new Map(),hdCtl=new Map(),tries=new Map();
const giveUp=(set,n,e)=>{if(e&&e.message==='cancelled')return;set.add(n);const k=(tries.get(n)||0)+1;tries.set(n,k);if(k<4)setTimeout(()=>set.delete(n),1500*k)};
const Q={drawn:0,blank:0,stand:0,still:false,hdT0:0,hdMs:[]};   // [intro] measured: frames drawn, front shown black, front stood in, sharp-frame delay
const cut=document.createElement('canvas');cut.width=FW;cut.height=FH;const cutCtx=cut.getContext('2d');
function frameCanvas(im){cutCtx.clearRect(0,0,FW,FH);cutCtx.drawImage(im,0,0,FW,FH);return cut}
const canvas=document.querySelector('#tb'),still=document.querySelector('#still');  // [intro] canvas has an id now
const gl=canvas.getContext('webgl',{alpha:true,antialias:!COARSE,powerPreference:'high-performance'});
// Open on the doves: frame 173, which is position 141 since frames are shifted by SEAM (32).
const START=141;
// [intro][fix] Production writes un-premultiplied colour into a premultiplied canvas. Where only faint ghost layers cover
// black, colour exceeds alpha and Chrome clamps it to grey veils, while Safari shows the frames' real colours
// (see the iPhone recording). Premultiplying makes every browser show the colours. Set false to restore production exactly.
const PREMULTIPLY_FIX=new URLSearchParams(location.search).get('premultiply')!=='0';
let target=START,position=START,yaw=0,targetYaw=0,pull=0,drag=null,last=0;
const SEAM=32,PERIOD=N-SEAM;const wrap=(n,m)=>((n%m)+m)%m;
function sample(n){let t=wrap(Math.floor(n),PERIOD)+SEAM;return {a:t,b:t>=N-SEAM?t-(N-SEAM):t,mix:t>=N-SEAM?(t-(N-SEAM))/SEAM:0}}
const clamp=n=>n;
function shader(type,src){const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s}
let program,buffer,loc,cache=new Map(),pending=new Set(),failed=new Set(),running=true;
if(gl){try{
// [intro] the focal length f is a uniform (was the constant 1.7320508) so the crossing can match the rendered lens.
program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,`attribute vec3 p;attribute vec2 uv;varying vec2 v;uniform float z,angle,distance,aspect,spacing,f;void main(){vec3 q=vec3(p.xy,p.z*spacing)+vec3(0.,0.,z);float c=cos(angle),s=sin(angle);q=vec3(c*q.x+s*q.z,q.y,-s*q.x+c*q.z);q.z-=distance;float near=.018,far=100.;gl_Position=vec4(q.x*f/aspect,q.y*f,(-(far+near)*q.z-2.*far*near)/(far-near),-q.z);v=uv;}`));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,`precision highp float;
varying vec2 v;
uniform sampler2D image,nextImage;
uniform vec2 imageSize,nextSize;
uniform float blend,opacity;
vec3 filmSample(sampler2D tex,vec2 uv,vec2 size){
 vec2 p=uv*size-.5,f=fract(p);
 vec2 eased=f*f*(3.-2.*f);
 vec2 q=(floor(p)+mix(f,eased,.32)+.5)/size;
 vec2 d=1./size;
 vec3 c=texture2D(tex,q).rgb;
 vec3 soft=(texture2D(tex,q+vec2(d.x,0.)).rgb+texture2D(tex,q-vec2(d.x,0.)).rgb+texture2D(tex,q+vec2(0.,d.y)).rgb+texture2D(tex,q-vec2(0.,d.y)).rgb)*.25;
 vec3 detail=c-soft;
 float edge=smoothstep(.025,.12,length(detail));
 // Fine detail gets a restrained lift; low contrast blocks receive slight diffusion.
 vec3 sharpened=c+clamp(detail,vec3(-.035),vec3(.035))*.24*edge;
 return mix(sharpened,soft,.075*(1.-edge));
}
void main(){
 vec3 c=filmSample(image,v,imageSize);
 if(blend>.0001)c=mix(c,filmSample(nextImage,v,nextSize),blend);
 // Static, fine luminance grain: no extra downloads or animation timer.
 vec2 pixel=gl_FragCoord.xy;
 float grain=fract(52.9829189*fract(dot(pixel,vec2(.06711056,.00583715))))-.5;
 float luma=dot(c,vec3(.2126,.7152,.0722));
 c+=grain*.014*smoothstep(.015,.12,luma);
 // [intro][fix] premultiplied output: identical framebuffer colour, but no browser-dependent clamp where only faint layers cover black
 gl_FragColor=PREMULTIPLY?vec4(clamp(c,0.,1.)*opacity,opacity):vec4(clamp(c,0.,1.),opacity);
}`.replace('PREMULTIPLY',PREMULTIPLY_FIX?'true':'false')));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program);
loc={};for(const name of ['z','angle','distance','aspect','blend','opacity','image','nextImage','spacing','imageSize','nextSize','f'])loc[name]=gl.getUniformLocation(program,name);
const vertices=[];function quad(a,b,c,d){for(const p of [a,b,c,a,c,d])vertices.push(...p)}
const x=4/3,y=1,d=-.14;
quad([-x,-y,0,0,1],[x,-y,0,1,1],[x,y,0,1,0],[-x,y,0,0,0]);
// Continuous edge ribbons carry the image perimeter through time.
quad([-x,-y,0,0,1],[-x,y,0,0,0],[-x,y,d,0,0],[-x,-y,d,0,1]);
quad([x,-y,0,1,1],[x,-y,d,1,1],[x,y,d,1,0],[x,y,0,1,0]);
quad([-x,y,0,0,0],[x,y,0,1,0],[x,y,d,1,0],[-x,y,d,0,0]);
quad([-x,-y,0,0,1],[-x,-y,d,0,1],[x,-y,d,1,1],[x,-y,0,1,1]);
buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(vertices),gl.STATIC_DRAW);for(const [name,size,offset] of [['p',3,0],['uv',2,12]]){let a=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,size,gl.FLOAT,false,20,offset)}gl.enable(gl.BLEND);if(PREMULTIPLY_FIX)gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);else gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.clearColor(0,0,0,0);
}catch(e){running=false;console.error(e)}}else running=false;
function load(n){if(!running||n<0||n>=N||cache.has(n)||pending.has(n)||failed.has(n)||pending.size>=LOAD_MAX)return;pending.add(n);const ctl={};pendingCtl.set(n,ctl);decodeFrame(frameUrl(n),ctl).then(fr=>{pending.delete(n);pendingCtl.delete(n);if(!running){freeFrame(fr);return}const im=frameCanvas(fr);freeFrame(fr);let t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,im);cache.set(n,t)},e=>{pending.delete(n);pendingCtl.delete(n);giveUp(failed,n,e)})}
// Sharp front frames are resampled to the size the front image is actually drawn at, so a phone holds no more
// detail than its screen shows. hdW is that width in device pixels; 0 means the 640 frames already cover it.
let hdW=0;const hdCache=new Map(),hdPending=new Set(),hdFailed=new Set(),texSize=new WeakMap();
const hcut=document.createElement('canvas'),hcutCtx=hcut.getContext('2d');
function fitHd(){const aspect=canvas.width/canvas.height,distance=Math.max(2.35,2.5/aspect),w=canvas.width*(4/3)*1.7320508/aspect/distance;hdW=w>FW*1.1?Math.min(HW,Math.ceil(w/64)*64):0}
// Sharp frames are single 1280x960 images too (intro/tb/h).
function hdLoad(n){if(!running||!hdW||n<0||n>=N||hdCache.has(n)||hdPending.has(n)||hdFailed.has(n)||hdPending.size>=HD_MAX)return;hdPending.add(n);const ctl={};hdCtl.set(n,ctl);decodeFrame(frameUrl(n,true),ctl).then(im=>{hdPending.delete(n);hdCtl.delete(n);if(!running||!hdW){freeFrame(im);return}const w=hdW,h=Math.round(w*3/4);if(hcut.width!==w||hcut.height!==h){hcut.width=w;hcut.height=h}hcutCtx.imageSmoothingEnabled=true;hcutCtx.imageSmoothingQuality='high';hcutCtx.drawImage(im,0,0,HW,HH,0,0,w,h);freeFrame(im);let t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,hcut);texSize.set(t,[w,h]);hdCache.set(n,t)},e=>{hdPending.delete(n);hdCtl.delete(n);giveUp(hdFailed,n,e)})}
// The film filter in the shader works on the texture's own pixel grid, so it's told each frame's real size.
function sizeOf(t){return texSize.get(t)||[FW,FH]}
function bindPair(a,b){gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,a);gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,b);gl.uniform2fv(loc.imageSize,sizeOf(a));gl.uniform2fv(loc.nextSize,sizeOf(b))}
// Draw at the screen's full sharpness (up to 3x) so the sharp frames show on phones too. A device that can't keep
// a steady frame rate at that size steps down (3x, 2x, 1.5x, 1x) and stays there.
let maxScale=3,slowT=0,slowN=0;
function pace(raw,now){if(raw>.1||now<3000||document.hidden)return;slowT+=raw;if(++slowN<90)return;if(slowT/slowN>1/40&&maxScale>1){maxScale=maxScale>2?2:maxScale>1.5?1.5:1;resize()}slowT=0;slowN=0}
function resize(){let r=Math.min(devicePixelRatio||1,maxScale);canvas.width=Math.round(innerWidth*r);canvas.height=Math.round(innerHeight*r);if(gl)gl.viewport(0,0,canvas.width,canvas.height);fitHd()}addEventListener('resize',resize);resize();
let fallbackFrame=-1;const smooth=(a,b,x)=>{let t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t)};

// ---------------------------------------------------------------------------------------------- [intro]
// Entrance support. While the visitor is on the stairs the viewer only streams the textures it will need;
// it starts drawing (hidden, under the intro) near the bottom, holding the camera exactly where the
// rendered shot ends; the crossing then dollies from that distance to the normal resting distance.
const F60=1.7320508;
let mode='idle';            // 'idle' -> 'hold' -> 'cross' -> 'live'
let hold={d:9,f:F60};       // rendered camera at the handoff, in viewer units / focal length
let cross=null;             // {t0,T,d0,v0,f0,done}
const restDistance=aspect=>Math.max(2.35,2.5/aspect);
function startPlanes(){     // the plane set the viewer draws at rest on START (front view)
  const out=[],stride=4,radius=72,center=START;
  for(let a=0;a<4;a++)out.push(sample(center+a).a);
  const ghosts=[];for(let k=-radius;k<=radius;k+=stride){const i=Math.floor(START/stride)*stride+k;if(i<center||i>center+3)ghosts.push(i)}
  ghosts.sort((a,b)=>Math.abs(START-a)-Math.abs(START-b));for(const i of ghosts)out.push(sample(i).a);
  return out}
const NEEDED=startPlanes();
let preloading=false;
function preloadTick(){if(!running||mode==='live')return;for(const n of NEEDED)load(n);if(NEEDED.some(n=>!cache.has(n)&&!failed.has(n)))setTimeout(preloadTick,120)}
function crossingCamera(now,aspect){
  const d1=restDistance(aspect);
  if(mode==='hold')return {d:hold.d,f:hold.f};
  const c=cross,t=Math.min(1,(now-c.t0)/1000/c.T),T=c.T;
  const t2=t*t,t3=t2*t,dd=c.d0-d1;
  const v0=Math.sign(c.v0)===Math.sign(-dd)?Math.max(-2*Math.abs(dd)/T,Math.min(2*Math.abs(dd)/T,c.v0)):0;
  const d=(2*t3-3*t2+1)*c.d0+(t3-2*t2+t)*T*v0+(-2*t3+3*t2)*d1;   // cubic Hermite, ends at rest with zero speed
  const f=c.f0+(F60-c.f0)*smooth(0,1,t);
  if(t>=1&&!c.done){c.done=true;setTimeout(goLive,0)}
  return {d,f}}
function goLive(){cross=null;mode='live';guardWheelUntil=performance.now()+3000;Entry.set('INSIDE');try{canvas.focus({preventScroll:true})}catch(e){}hideChrome()}
const inside=()=>Entry.state==='INSIDE';
// Residual trackpad/wheel momentum from the entrance must not scroll the block: swallow wheel events after entry
// until the stream breaks (a >140 ms gap means a new gesture), at most 3 s. Gaps are timed at window level because
// during the entrance the wheel events land on the intro layer, not on this canvas.
let guardWheelUntil=0,lastWheelAt=0,wheelGap=1e9;
addEventListener('wheel',()=>{const now=performance.now();wheelGap=now-lastWheelAt;lastWheelAt=now},{capture:true,passive:true});
function wheelGuard(){if(performance.now()<guardWheelUntil){if(wheelGap>140){guardWheelUntil=0;return false}return true}return false}
window.NolfeTimeBlock={
  get running(){return running},
  get canvas(){return canvas},
  preload(){if(preloading)return;preloading=true;preloadTick()},
  ready(){return !running||NEEDED.every(n=>cache.has(n)||failed.has(n))},
  progress(){return NEEDED.filter(n=>cache.has(n)).length/NEEDED.length},
  hold(d,f){if(mode==='idle'||mode==='hold'){mode='hold';hold={d,f};this.preload()}},
  release(){if(mode==='hold')mode='idle'},
  cross({d0,v0=0,f0=F60}){if(mode==='live'||cross)return;const aspect=canvas.width/canvas.height,dd=Math.abs(d0-restDistance(aspect));
    cross={t0:performance.now(),T:Math.max(1.1,Math.min(1.9,.9+.12*dd)),d0,v0,f0,done:false};mode='cross';
    if(!running)setTimeout(goLive,700)},
  enterNow(){cross=null;mode='live';if(!inside())goLive()},
  stats(){return {mode,target:+target.toFixed(2),cache:cache.size,hd:hdCache.size,needed:NEEDED.length,ready:this.ready(),maxScale,canvas:[canvas.width,canvas.height],drawn:Q.drawn,blank:Q.blank,stand:Q.stand,hdMs:Q.hdMs.slice(-20)}},
};
// ---------------------------------------------------------------------------------------------- [/intro]

function draw(now){const raw=(now-last)/1000;let dt=Math.min(raw,.05)||.016;last=now;
if(mode==='idle'){requestAnimationFrame(draw);return}                       // [intro] no GL work on the stairs
if(running&&mode==='live')pace(raw,now);                                   // [intro] judge frame rate only once it owns the screen
const ease=1-Math.exp(-dt*10);position+=(target-position)*ease;yaw+=(targetYaw-yaw)*ease;let side=Math.abs(Math.sin(yaw));pull+=(side-pull)*ease;const center=Math.floor(position),current=sample(center);
if(!running&&current.a!==fallbackFrame){fallbackFrame=current.a;still.src=frameUrl(current.a)}
if(running){const planes=[];const stride=pull>.2?3:4;const radius=pull>.2?180:72;
for(let k=-radius;k<=radius;k+=stride){let index=Math.floor(position/stride)*stride+k;let pair=sample(index);let z=(position-index)*.14;let depth=Math.cos(yaw)*z;if(index<center||index>center+3)planes.push({index,pair,z,depth,anchor:-1})}
// Always include the exact current frame and its three immediate successors.
for(let anchor=0;anchor<4;anchor++){let index=center+anchor,z=(position-index)*.14;planes.push({index,pair:sample(index),z,depth:Math.cos(yaw)*z,anchor})}
// [intro] where the view will come to rest (a fling glides on: its remaining travel is speed x decay time) loads first
const land=target+(gliding?glideV*glideTau:0),landing=[0,1,2,3].map(a=>sample(Math.floor(land)+a)),nearLand=Math.abs(land-position)<12;
if(nearLand)hdLoad(landing[0].a);   // its sharp version is requested before the regular frames, so it isn't queued behind them
for(const p of landing){load(p.a);if(p.mix>0)load(p.b)}
for(const q of planes.filter(q=>q.anchor>=0)){load(q.pair.a);if(q.pair.mix>0)load(q.pair.b)}for(const q of [...planes].sort((a,b)=>Math.abs(a.z)-Math.abs(b.z))){load(q.pair.a);if(q.pair.mix>0)load(q.pair.b)}
const settled=Math.abs(target-position)<1.5&&!gliding;const hdKeep=new Set();
// [intro] the sharp version of the frame it will rest on starts while it is still gliding in, ahead of the frames behind it
if(nearLand)hdKeep.add(landing[0].a);if(settled)hdLoad(current.a);for(const q of planes)if(q.anchor>=0){hdKeep.add(q.pair.a);hdKeep.add(q.pair.b);if(settled){hdLoad(q.pair.a);if(q.pair.mix>0)hdLoad(q.pair.b)}}
for(const [n,t] of hdCache)if(!hdKeep.has(n)&&hdCache.size>HD_KEEP){gl.deleteTexture(t);hdCache.delete(n)}
const pick=(n,front)=>(front&&hdCache.get(n))||cache.get(n);
const nearest=n=>{for(let d=1;d<=36;d++){const t=cache.get(n-d)||cache.get(n+d);if(t)return t}return null};   // [intro] never black
const keep=new Set();for(const q of planes){keep.add(q.pair.a);keep.add(q.pair.b)}for(const p of landing){keep.add(p.a);keep.add(p.b)}
for(const [n,c] of pendingCtl)if(!keep.has(n)&&c.cancel)c.cancel();for(const [n,c] of hdCtl)if(!hdKeep.has(n)&&c.cancel)c.cancel();   // [intro] drop what the view has left
for(const [n,t] of cache)if(!keep.has(n)&&cache.size>TEX_CAP){gl.deleteTexture(t);cache.delete(n)}
gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.useProgram(program);const aspect=canvas.width/canvas.height;
// Wider front framing preserves the original aspect ratio; side view exposes a long time ribbon.
let distance=Math.max(2.35,2.5/aspect)+pull*4.5,focal=F60;
if(mode==='hold'||mode==='cross'){const c=crossingCamera(now,aspect);distance=c.d;focal=c.f}   // [intro]
gl.uniform1f(loc.f,focal);                                                                      // [intro]
gl.uniform1f(loc.spacing,stride);gl.uniform1f(loc.angle,yaw);gl.uniform1f(loc.distance,distance);gl.uniform1f(loc.aspect,aspect);gl.uniform1i(loc.image,0);gl.uniform1i(loc.nextImage,1);
planes.sort((a,b)=>a.depth-b.depth);
let drew=false;
for(const q of planes){const front=q.anchor>=0;let t=pick(q.pair.a,front)||nearest(q.pair.a);if(!t)continue;
const travel=q.z;const fadeNear=1-smooth(distance*.2,distance*.93,travel);const fadeFar=smooth(-12,-6,travel);const frontAlpha=.20*fadeNear*fadeFar;
const sideAlpha=.24;let alpha=frontAlpha*(1-pull)+sideAlpha*pull;
alpha*=1-smooth(radius*.14*.77,radius*.14,Math.abs(travel));
if(q.anchor>=0)alpha=[1,.9,.8,.7][q.anchor];
if(alpha<.002)continue;
bindPair(t,pick(q.pair.b,front)||t);gl.uniform1f(loc.blend,cache.has(q.pair.b)?q.pair.mix:0);gl.uniform1f(loc.opacity,alpha);gl.uniform1f(loc.z,q.z);gl.drawArrays(gl.TRIANGLES,0,6);
// Per-frame edge ribbons make the passage of time visible from the side.
if(pull>.05){gl.uniform1f(loc.opacity,.55*pull*fadeFar);gl.drawArrays(gl.TRIANGLES,6,24)}drew=true;
}
// Repaint only the current frame's rectangle after the translucent layers.
// At a front-facing angle this clears overlapping ghosts inside the image,
// while leaving every layered border outside its silhouette untouched.
const clarity=smooth(Math.cos(Math.PI/9),Math.cos(Math.PI/36),Math.cos(yaw));
const focus=planes.find(q=>q.anchor===0),focusTexture=pick(current.a,true)||nearest(current.a);
if(mode==='live'){Q.drawn++;if(!cache.has(current.a)&&!hdCache.has(current.a)){if(focusTexture)Q.stand++;else Q.blank++}const still_=Math.abs(target-position)<.05&&!gliding;if(still_&&!Q.still&&hdW){if(hdCache.has(current.a))Q.hdMs.push(0);else Q.hdT0=now}Q.still=still_;if(Q.hdT0&&(hdCache.has(current.a)||!still_)){if(hdCache.has(current.a))Q.hdMs.push(Math.round(now-Q.hdT0));Q.hdT0=0}}
if(clarity>0&&focusTexture){
bindPair(focusTexture,pick(current.b,true)||focusTexture);
gl.uniform1f(loc.blend,cache.has(current.b)?current.mix:0);
gl.uniform1f(loc.opacity,clarity);gl.uniform1f(loc.z,focus.z);
gl.drawArrays(gl.TRIANGLES,0,6);drew=true;
}
if(drew)still.style.visibility='hidden';
}requestAnimationFrame(draw)}requestAnimationFrame(draw);
// [intro] every input handler below is inert until the visitor is INSIDE.
canvas.addEventListener('pointerdown',e=>{if(!inside())return;stopGlide();drag={x:e.clientX,y:e.clientY,t:target,a:targetYaw,axis:null,trail:[]};canvas.setPointerCapture(e.pointerId)});
canvas.addEventListener('pointermove',e=>{if(!drag)return;let dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(!drag.axis&&Math.hypot(dx,dy)>5)drag.axis=Math.abs(dx)>Math.abs(dy)?'orbit':'time';if(drag.axis==='orbit')targetYaw=drag.a+dx/innerWidth*Math.PI*2;else if(drag.axis==='time'){target=clamp(drag.t-dy/innerHeight*180);const now=performance.now();drag.trail.push([now,target]);while(drag.trail.length>2&&now-drag.trail[0][0]>100)drag.trail.shift()}});
// Momentum after a time swipe: a harder flick starts faster AND coasts longer before it comes to rest,
// so short swipes settle almost at once and long, fast ones carry far through the block.
let glideV=0,glideTau=0,glideAt=0,gliding=false;
function stopGlide(){glideV=0;gliding=false}
function glide(now){if(!gliding)return;const dt=Math.min(50,now-glideAt);glideAt=now;const next=clamp(target+glideV*dt);if(next===target&&(next===0||next===N-1))return stopGlide();target=next;glideV*=Math.exp(-dt/glideTau);if(Math.abs(glideV)<.004)return stopGlide();requestAnimationFrame(glide)}
function release(){const d=drag;drag=null;if(!d||d.axis!=='time'||d.trail.length<2)return;const now=performance.now(),[t0,p0]=d.trail[0],[t1,p1]=d.trail[d.trail.length-1];if(now-t1>80||t1-t0<8)return;const v=(p1-p0)/(t1-t0);if(Math.abs(v)<.01)return;glideV=Math.max(-3,Math.min(3,v));glideTau=Math.min(900,120+380*Math.abs(glideV));glideAt=now;if(!gliding){gliding=true;requestAnimationFrame(glide)}}canvas.addEventListener('pointerup',release);canvas.addEventListener('pointercancel',release);canvas.addEventListener('lostpointercapture',release);
canvas.addEventListener('wheel',e=>{e.preventDefault();if(!inside()||wheelGuard())return;stopGlide();if(e.shiftKey||Math.abs(e.deltaX)>Math.abs(e.deltaY))targetYaw+=(e.deltaX||e.deltaY)*.004;else target=clamp(target+e.deltaY*.12)},{passive:false});
canvas.addEventListener('dblclick',()=>{if(!inside())return;targetYaw=Math.round(targetYaw/(Math.PI*2))*Math.PI*2});
addEventListener('keydown',e=>{if(!inside())return;if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','Escape'].includes(e.key))return;e.preventDefault();stopGlide();if(e.key==='ArrowUp')target=clamp(target+1);if(e.key==='ArrowDown')target=clamp(target-1);if(e.key==='ArrowLeft')targetYaw-=Math.PI/24;if(e.key==='ArrowRight')targetYaw+=Math.PI/24;if(e.key==='Home')target=START;if(e.key==='End')target=N-1;if(e.key==='Escape')targetYaw=Math.round(targetYaw/(Math.PI*2))*Math.PI*2});
// Like the original page: the site header (Wix's, outside this frame) slides away while the time block
// moves and drops back in once the motion (and any glide) has settled. The page's code listens for these messages.
// [intro] The header stays away for the whole entrance and first appears once the visitor is inside.
let chromeTimer,chromeHeld=false,chromeShown=true;
function tellChrome(v){if(v===chromeShown)return;chromeShown=v;try{parent.postMessage({nolfe:'chrome',visible:v},'*')}catch(e){}}
function revealChrome(){if(!inside()||chromeHeld||(gliding&&Math.abs(glideV)>.15)||Math.abs(target-position)>.5||Math.abs(targetYaw-yaw)>.02){chromeTimer=setTimeout(revealChrome,60);return}tellChrome(true)}   // [intro] quicker
function hideChrome(){clearTimeout(chromeTimer);tellChrome(false);chromeTimer=setTimeout(revealChrome,300)}
tellChrome(false);                                                                               // [intro]
canvas.addEventListener('wheel',()=>{if(inside())hideChrome()},{passive:true});
canvas.addEventListener('pointerdown',()=>{if(inside())chromeHeld=true});
canvas.addEventListener('pointermove',()=>{if(chromeHeld&&drag&&drag.axis)hideChrome()});
for(const name of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(name,()=>{chromeHeld=false;if(!chromeShown){clearTimeout(chromeTimer);chromeTimer=setTimeout(revealChrome,300)}});
addEventListener('keydown',e=>{if(inside()&&['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','Escape'].includes(e.key))hideChrome()});
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();running=false;still.style.visibility='visible'});canvas.addEventListener('webglcontextrestored',()=>{try{history.replaceState(history.state,'',location.pathname+location.search+'#inside')}catch(e){}location.reload()});   // [intro] reopen inside, not at the door (no new history entry)

// In-frame site navigation (production #nolfe-overlay). [intro] Hidden by CSS until INSIDE, then behaves as before.
(()=>{const o=document.getElementById('nolfe-overlay'),c=canvas;if(!o)return;let timer,held=false;
// [intro] Faster than production: the menus come back 0.3 s after the last real input (was 1 s) and once the view is
// nearly still (was: fully settled), and 0.25 s after arriving (was 0.7 s). A trackpad's coasting tail (small, shrinking
// wheel deltas after the finger lifts) no longer keeps them away.
const MENU_AFTER=300,MENU_ENTRY=250;let wAbs=0,wAt=0;
function show(){if(!inside()||held||(gliding&&Math.abs(glideV)>.15)||Math.abs(target-position)>.5){timer=setTimeout(show,60);return}o.classList.remove('busy')}
function busy(){clearTimeout(timer);o.classList.add('busy');timer=setTimeout(show,MENU_AFTER)}
o.classList.add('busy');Entry.on(s=>{if(s==='INSIDE'){clearTimeout(timer);timer=setTimeout(show,MENU_ENTRY)}});
c.addEventListener('wheel',e=>{if(!inside())return;const a=Math.abs(e.deltaY)+Math.abs(e.deltaX),now=performance.now(),coasting=now-wAt<80&&a<=wAbs&&a<12;wAbs=a;wAt=now;if(!coasting)busy()},{passive:true});c.addEventListener('pointerdown',()=>{if(!inside())return;held=true;busy()});c.addEventListener('pointermove',()=>{if(held)busy()});for(const t of ['pointerup','pointercancel','lostpointercapture'])c.addEventListener(t,()=>{if(!held)return;held=false;busy()});window.addEventListener('keydown',e=>{if(!inside())return;if(e.key==='Tab'){clearTimeout(timer);show()}else if(e.key.startsWith('Arrow'))busy()})})();
})();
