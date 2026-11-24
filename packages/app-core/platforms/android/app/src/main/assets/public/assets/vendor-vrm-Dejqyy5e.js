import{S as Mr,T as xr,U as yr,a as _e,M as W,C as O,b as Rr,B as Tr,V as _,Q as A,O as Be,c as ce,d as wr,G as Mn,e as Pt,f as j,g as pe,A as Sr,E as Et,h as N,i as xn,D as yn,j as Rn,L as Ye,k as Lt,l as U,m as Ar,n as Y,o as Pr,R as Q,I as Er,p as Kn,q as ei,r as Lr,v as ti,u as Tn,s as br,t as Ir,w as Je,x as Nr,y as Cr,z as ni,F as He,H as X,J as lt,K as bt,N as Or,P as Ur,W as Vr,X as Fr,Y as Ke,Z as Dr,_ as Br,$ as Hr,a0 as kr,a1 as Wr,a2 as ee,a3 as zr,a4 as L,a5 as ne,a6 as ie,a7 as Xr,a8 as jr}from"./vendor-three-KgaLXAFm.js";var Le=(e,t,n)=>new Promise((i,r)=>{var o=a=>{try{l(n.next(a))}catch(u){r(u)}},s=a=>{try{l(n.throw(a))}catch(u){r(u)}},l=a=>a.done?i(a.value):Promise.resolve(a.value).then(o,s);l((n=n.apply(e,t)).next())}),S=(e,t,n)=>new Promise((i,r)=>{var o=a=>{try{l(n.next(a))}catch(u){r(u)}},s=a=>{try{l(n.throw(a))}catch(u){r(u)}},l=a=>a.done?i(a.value):Promise.resolve(a.value).then(o,s);l((n=n.apply(e,t)).next())}),ut=class extends Be{constructor(e){super(),this.weight=0,this.isBinary=!1,this.overrideBlink="none",this.overrideLookAt="none",this.overrideMouth="none",this._binds=[],this.name=`VRMExpression_${e}`,this.expressionName=e,this.type="VRMExpression",this.visible=!1}get binds(){return this._binds}get overrideBlinkAmount(){return this.overrideBlink==="block"?0<this.outputWeight?1:0:this.overrideBlink==="blend"?this.outputWeight:0}get overrideLookAtAmount(){return this.overrideLookAt==="block"?0<this.outputWeight?1:0:this.overrideLookAt==="blend"?this.outputWeight:0}get overrideMouthAmount(){return this.overrideMouth==="block"?0<this.outputWeight?1:0:this.overrideMouth==="blend"?this.outputWeight:0}get outputWeight(){return this.isBinary?this.weight>.5?1:0:this.weight}addBind(e){this._binds.push(e)}deleteBind(e){const t=this._binds.indexOf(e);t>=0&&this._binds.splice(t,1)}applyWeight(e){var t;let n=this.outputWeight;n*=(t=e?.multiplier)!=null?t:1,this.isBinary&&n<1&&(n=0),this._binds.forEach(i=>i.applyWeight(n))}clearAppliedWeight(){this._binds.forEach(e=>e.clearAppliedWeight())}};function ii(e,t,n){var i,r;const o=e.parser.json,s=(i=o.nodes)==null?void 0:i[t];if(s==null)return console.warn(`extractPrimitivesInternal: Attempt to use nodes[${t}] of glTF but the node doesn't exist`),null;const l=s.mesh;if(l==null)return null;const a=(r=o.meshes)==null?void 0:r[l];if(a==null)return console.warn(`extractPrimitivesInternal: Attempt to use meshes[${l}] of glTF but the mesh doesn't exist`),null;const u=a.primitives.length,d=[];return n.traverse(h=>{d.length<u&&h.isMesh&&d.push(h)}),d}function wn(e,t){return S(this,null,function*(){const n=yield e.parser.getDependency("node",t);return ii(e,t,n)})}function Sn(e){return S(this,null,function*(){const t=yield e.parser.getDependencies("node"),n=new Map;return t.forEach((i,r)=>{const o=ii(e,r,i);o!=null&&n.set(r,o)}),n})}var ke={Aa:"aa",Ih:"ih",Ou:"ou",Ee:"ee",Oh:"oh",Blink:"blink",Happy:"happy",Angry:"angry",Sad:"sad",Relaxed:"relaxed",LookUp:"lookUp",Surprised:"surprised",LookDown:"lookDown",LookLeft:"lookLeft",LookRight:"lookRight",BlinkLeft:"blinkLeft",BlinkRight:"blinkRight",Neutral:"neutral"};function ri(e){return Math.max(Math.min(e,1),0)}var dt=class oi{constructor(){this.blinkExpressionNames=["blink","blinkLeft","blinkRight"],this.lookAtExpressionNames=["lookLeft","lookRight","lookUp","lookDown"],this.mouthExpressionNames=["aa","ee","ih","oh","ou"],this._expressions=[],this._expressionMap={}}get expressions(){return this._expressions.concat()}get expressionMap(){return Object.assign({},this._expressionMap)}get presetExpressionMap(){const t={},n=new Set(Object.values(ke));return Object.entries(this._expressionMap).forEach(([i,r])=>{n.has(i)&&(t[i]=r)}),t}get customExpressionMap(){const t={},n=new Set(Object.values(ke));return Object.entries(this._expressionMap).forEach(([i,r])=>{n.has(i)||(t[i]=r)}),t}copy(t){return this._expressions.concat().forEach(i=>{this.unregisterExpression(i)}),t._expressions.forEach(i=>{this.registerExpression(i)}),this.blinkExpressionNames=t.blinkExpressionNames.concat(),this.lookAtExpressionNames=t.lookAtExpressionNames.concat(),this.mouthExpressionNames=t.mouthExpressionNames.concat(),this}clone(){return new oi().copy(this)}getExpression(t){var n;return(n=this._expressionMap[t])!=null?n:null}registerExpression(t){this._expressions.push(t),this._expressionMap[t.expressionName]=t}unregisterExpression(t){const n=this._expressions.indexOf(t);n===-1&&console.warn("VRMExpressionManager: The specified expressions is not registered"),this._expressions.splice(n,1),delete this._expressionMap[t.expressionName]}getValue(t){var n;const i=this.getExpression(t);return(n=i?.weight)!=null?n:null}setValue(t,n){const i=this.getExpression(t);i&&(i.weight=ri(n))}resetValues(){this._expressions.forEach(t=>{t.weight=0})}getExpressionTrackName(t){const n=this.getExpression(t);return n?`${n.name}.weight`:null}update(){const t=this._calculateWeightMultipliers();this._expressions.forEach(n=>{n.clearAppliedWeight()}),this._expressions.forEach(n=>{let i=1;const r=n.expressionName;this.blinkExpressionNames.indexOf(r)!==-1&&(i*=t.blink),this.lookAtExpressionNames.indexOf(r)!==-1&&(i*=t.lookAt),this.mouthExpressionNames.indexOf(r)!==-1&&(i*=t.mouth),n.applyWeight({multiplier:i})})}_calculateWeightMultipliers(){let t=1,n=1,i=1;return this._expressions.forEach(r=>{t-=r.overrideBlinkAmount,n-=r.overrideLookAtAmount,i-=r.overrideMouthAmount}),t=Math.max(0,t),n=Math.max(0,n),i=Math.max(0,i),{blink:t,lookAt:n,mouth:i}}},ue={Color:"color",EmissionColor:"emissionColor",ShadeColor:"shadeColor",MatcapColor:"matcapColor",RimColor:"rimColor",OutlineColor:"outlineColor"},Yr={_Color:ue.Color,_EmissionColor:ue.EmissionColor,_ShadeColor:ue.ShadeColor,_RimColor:ue.RimColor,_OutlineColor:ue.OutlineColor},Gr=new O,si=class ai{constructor({material:t,type:n,targetValue:i,targetAlpha:r}){this.material=t,this.type=n,this.targetValue=i,this.targetAlpha=r??1;const o=this._initColorBindState(),s=this._initAlphaBindState();this._state={color:o,alpha:s}}applyWeight(t){const{color:n,alpha:i}=this._state;if(n!=null){const{propertyName:r,deltaValue:o}=n,s=this.material[r];s?.add(Gr.copy(o).multiplyScalar(t))}if(i!=null){const{propertyName:r,deltaValue:o}=i;this.material[r]!=null&&(this.material[r]+=o*t)}}clearAppliedWeight(){const{color:t,alpha:n}=this._state;if(t!=null){const{propertyName:i,initialValue:r}=t,o=this.material[i];o?.copy(r)}if(n!=null){const{propertyName:i,initialValue:r}=n;this.material[i]!=null&&(this.material[i]=r)}}_initColorBindState(){var t,n,i;const{material:r,type:o,targetValue:s}=this,l=this._getPropertyNameMap(),a=(n=(t=l?.[o])==null?void 0:t[0])!=null?n:null;if(a==null)return console.warn(`Tried to add a material color bind to the material ${(i=r.name)!=null?i:"(no name)"}, the type ${o} but the material or the type is not supported.`),null;const d=r[a].clone(),h=new O(s.r-d.r,s.g-d.g,s.b-d.b);return{propertyName:a,initialValue:d,deltaValue:h}}_initAlphaBindState(){var t,n,i;const{material:r,type:o,targetAlpha:s}=this,l=this._getPropertyNameMap(),a=(n=(t=l?.[o])==null?void 0:t[1])!=null?n:null;if(a==null&&s!==1)return console.warn(`Tried to add a material alpha bind to the material ${(i=r.name)!=null?i:"(no name)"}, the type ${o} but the material or the type does not support alpha.`),null;if(a==null)return null;const u=r[a],d=s-u;return{propertyName:a,initialValue:u,deltaValue:d}}_getPropertyNameMap(){var t,n;return(n=(t=Object.entries(ai._propertyNameMapMap).find(([i])=>this.material[i]===!0))==null?void 0:t[1])!=null?n:null}};si._propertyNameMapMap={isMeshStandardMaterial:{color:["color","opacity"],emissionColor:["emissive",null]},isMeshBasicMaterial:{color:["color","opacity"]},isMToonMaterial:{color:["color","opacity"],emissionColor:["emissive",null],outlineColor:["outlineColorFactor",null],matcapColor:["matcapFactor",null],rimColor:["parametricRimColorFactor",null],shadeColor:["shadeColorFactor",null]}};var ht=si,Se=class{constructor({primitives:e,index:t,weight:n}){this.primitives=e,this.index=t,this.weight=n}applyWeight(e){this.primitives.forEach(t=>{var n;((n=t.morphTargetInfluences)==null?void 0:n[this.index])!=null&&(t.morphTargetInfluences[this.index]+=this.weight*e)})}clearAppliedWeight(){this.primitives.forEach(e=>{var t;((t=e.morphTargetInfluences)==null?void 0:t[this.index])!=null&&(e.morphTargetInfluences[this.index]=0)})}},An=new ce,li=class ui{constructor({material:t,scale:n,offset:i}){var r,o;this.material=t,this.scale=n,this.offset=i;const s=(r=Object.entries(ui._propertyNamesMap).find(([l])=>t[l]===!0))==null?void 0:r[1];s==null?(console.warn(`Tried to add a texture transform bind to the material ${(o=t.name)!=null?o:"(no name)"} but the material is not supported.`),this._properties=[]):(this._properties=[],s.forEach(l=>{var a;const u=(a=t[l])==null?void 0:a.clone();if(!u)return null;t[l]=u;const d=u.offset.clone(),h=u.repeat.clone(),c=i.clone().sub(d),p=n.clone().sub(h);this._properties.push({name:l,initialOffset:d,deltaOffset:c,initialScale:h,deltaScale:p})}))}applyWeight(t){this._properties.forEach(n=>{const i=this.material[n.name];i!==void 0&&(i.offset.add(An.copy(n.deltaOffset).multiplyScalar(t)),i.repeat.add(An.copy(n.deltaScale).multiplyScalar(t)))})}clearAppliedWeight(){this._properties.forEach(t=>{const n=this.material[t.name];n!==void 0&&(n.offset.copy(t.initialOffset),n.repeat.copy(t.initialScale))})}};li._propertyNamesMap={isMeshStandardMaterial:["map","emissiveMap","bumpMap","normalMap","displacementMap","roughnessMap","metalnessMap","alphaMap"],isMeshBasicMaterial:["map","specularMap","alphaMap"],isMToonMaterial:["map","normalMap","emissiveMap","shadeMultiplyTexture","rimMultiplyTexture","outlineWidthMultiplyTexture","uvAnimationMaskTexture"]};var ct=li,qr=new Set(["1.0","1.0-beta"]),di=class hi{get name(){return"VRMExpressionLoaderPlugin"}constructor(t){this.parser=t}afterRoot(t){return S(this,null,function*(){t.userData.vrmExpressionManager=yield this._import(t)})}_import(t){return S(this,null,function*(){const n=yield this._v1Import(t);if(n)return n;const i=yield this._v0Import(t);return i||null})}_v1Import(t){return S(this,null,function*(){var n,i;const r=this.parser.json;if(!(((n=r.extensionsUsed)==null?void 0:n.indexOf("VRMC_vrm"))!==-1))return null;const s=(i=r.extensions)==null?void 0:i.VRMC_vrm;if(!s)return null;const l=s.specVersion;if(!qr.has(l))return console.warn(`VRMExpressionLoaderPlugin: Unknown VRMC_vrm specVersion "${l}"`),null;const a=s.expressions;if(!a)return null;const u=new Set(Object.values(ke)),d=new Map;a.preset!=null&&Object.entries(a.preset).forEach(([c,p])=>{if(p!=null){if(!u.has(c)){console.warn(`VRMExpressionLoaderPlugin: Unknown preset name "${c}" detected. Ignoring the expression`);return}d.set(c,p)}}),a.custom!=null&&Object.entries(a.custom).forEach(([c,p])=>{if(u.has(c)){console.warn(`VRMExpressionLoaderPlugin: Custom expression cannot have preset name "${c}". Ignoring the expression`);return}d.set(c,p)});const h=new dt;return yield Promise.all(Array.from(d.entries()).map(c=>S(this,[c],function*([p,f]){var m,g,v,y,R,T,M;const x=new ut(p);if(t.scene.add(x),x.isBinary=(m=f.isBinary)!=null?m:!1,x.overrideBlink=(g=f.overrideBlink)!=null?g:"none",x.overrideLookAt=(v=f.overrideLookAt)!=null?v:"none",x.overrideMouth=(y=f.overrideMouth)!=null?y:"none",(R=f.morphTargetBinds)==null||R.forEach(w=>S(this,null,function*(){var P;if(w.node===void 0||w.index===void 0)return;const I=yield wn(t,w.node),E=w.index;if(!I.every(b=>Array.isArray(b.morphTargetInfluences)&&E<b.morphTargetInfluences.length)){console.warn(`VRMExpressionLoaderPlugin: ${f.name} attempts to index morph #${E} but not found.`);return}x.addBind(new Se({primitives:I,index:E,weight:(P=w.weight)!=null?P:1}))})),f.materialColorBinds||f.textureTransformBinds){const w=[];t.scene.traverse(P=>{const I=P.material;I&&(Array.isArray(I)?w.push(...I):w.push(I))}),(T=f.materialColorBinds)==null||T.forEach(P=>S(this,null,function*(){w.filter(E=>{var b;const C=(b=this.parser.associations.get(E))==null?void 0:b.materials;return P.material===C}).forEach(E=>{x.addBind(new ht({material:E,type:P.type,targetValue:new O().fromArray(P.targetValue),targetAlpha:P.targetValue[3]}))})})),(M=f.textureTransformBinds)==null||M.forEach(P=>S(this,null,function*(){w.filter(E=>{var b;const C=(b=this.parser.associations.get(E))==null?void 0:b.materials;return P.material===C}).forEach(E=>{var b,C;x.addBind(new ct({material:E,offset:new ce().fromArray((b=P.offset)!=null?b:[0,0]),scale:new ce().fromArray((C=P.scale)!=null?C:[1,1])}))})}))}h.registerExpression(x)}))),h})}_v0Import(t){return S(this,null,function*(){var n;const i=this.parser.json,r=(n=i.extensions)==null?void 0:n.VRM;if(!r)return null;const o=r.blendShapeMaster;if(!o)return null;const s=new dt,l=o.blendShapeGroups;if(!l)return s;const a=new Set;return yield Promise.all(l.map(u=>S(this,null,function*(){var d;const h=u.presetName,c=h!=null&&hi.v0v1PresetNameMap[h]||null,p=c??u.name;if(p==null){console.warn("VRMExpressionLoaderPlugin: One of custom expressions has no name. Ignoring the expression");return}if(a.has(p)){console.warn(`VRMExpressionLoaderPlugin: An expression preset ${h} has duplicated entries. Ignoring the expression`);return}a.add(p);const f=new ut(p);t.scene.add(f),f.isBinary=(d=u.isBinary)!=null?d:!1,u.binds&&u.binds.forEach(g=>S(this,null,function*(){var v;if(g.mesh===void 0||g.index===void 0)return;const y=[];if((v=i.nodes)==null||v.forEach((T,M)=>{T.mesh===g.mesh&&y.push(M)}),y.length===0){console.warn(`VRMExpressionLoaderPlugin: ${u.name} attempts to bind a morph target to the mesh #${g.mesh} but the mesh is not found or not used in the scene. Ignoring the bind.`);return}const R=g.index;yield Promise.all(y.map(T=>S(this,null,function*(){var M;const x=yield wn(t,T);if(!x.every(w=>Array.isArray(w.morphTargetInfluences)&&R<w.morphTargetInfluences.length)){console.warn(`VRMExpressionLoaderPlugin: ${u.name} attempts to index ${R}th morph but not found.`);return}f.addBind(new Se({primitives:x,index:R,weight:.01*((M=g.weight)!=null?M:100)}))})))}));const m=u.materialValues;m&&m.length!==0&&m.forEach(g=>{if(g.materialName===void 0||g.propertyName===void 0||g.targetValue===void 0)return;const v=[];t.scene.traverse(R=>{if(R.material){const T=R.material;Array.isArray(T)?v.push(...T.filter(M=>(M.name===g.materialName||M.name===g.materialName+" (Outline)")&&v.indexOf(M)===-1)):T.name===g.materialName&&v.indexOf(T)===-1&&v.push(T)}});const y=g.propertyName;v.forEach(R=>{if(y==="_MainTex_ST"){const M=new ce(g.targetValue[0],g.targetValue[1]),x=new ce(g.targetValue[2],g.targetValue[3]);x.y=1-x.y-M.y,f.addBind(new ct({material:R,scale:M,offset:x}));return}const T=Yr[y];if(T){f.addBind(new ht({material:R,type:T,targetValue:new O().fromArray(g.targetValue),targetAlpha:g.targetValue[3]}));return}console.warn(y+" is not supported")})}),s.registerExpression(f)}))),s})}};di.v0v1PresetNameMap={a:"aa",e:"ee",i:"ih",o:"oh",u:"ou",blink:"blink",joy:"happy",angry:"angry",sorrow:"sad",fun:"relaxed",lookup:"lookUp",lookdown:"lookDown",lookleft:"lookLeft",lookright:"lookRight",blink_l:"blinkLeft",blink_r:"blinkRight",neutral:"neutral"};var It=di,Qr={None:"none",Block:"block",Blend:"blend"},Nt=class de{constructor(t,n){this._firstPersonOnlyLayer=de.DEFAULT_FIRSTPERSON_ONLY_LAYER,this._thirdPersonOnlyLayer=de.DEFAULT_THIRDPERSON_ONLY_LAYER,this._initializedLayers=!1,this.humanoid=t,this.meshAnnotations=n}copy(t){if(this.humanoid!==t.humanoid)throw new Error("VRMFirstPerson: humanoid must be same in order to copy");return this.meshAnnotations=t.meshAnnotations.map(n=>({meshes:n.meshes.concat(),type:n.type})),this}clone(){return new de(this.humanoid,this.meshAnnotations).copy(this)}get firstPersonOnlyLayer(){return this._firstPersonOnlyLayer}get thirdPersonOnlyLayer(){return this._thirdPersonOnlyLayer}setup({firstPersonOnlyLayer:t=de.DEFAULT_FIRSTPERSON_ONLY_LAYER,thirdPersonOnlyLayer:n=de.DEFAULT_THIRDPERSON_ONLY_LAYER}={}){this._initializedLayers||(this._firstPersonOnlyLayer=t,this._thirdPersonOnlyLayer=n,this.meshAnnotations.forEach(i=>{i.meshes.forEach(r=>{i.type==="firstPersonOnly"?(r.layers.set(this._firstPersonOnlyLayer),r.traverse(o=>o.layers.set(this._firstPersonOnlyLayer))):i.type==="thirdPersonOnly"?(r.layers.set(this._thirdPersonOnlyLayer),r.traverse(o=>o.layers.set(this._thirdPersonOnlyLayer))):i.type==="auto"&&this._createHeadlessModel(r)})}),this._initializedLayers=!0)}_excludeTriangles(t,n,i,r){let o=0;if(n!=null&&n.length>0)for(let s=0;s<t.length;s+=3){const l=t[s],a=t[s+1],u=t[s+2],d=n[l],h=i[l];if(d[0]>0&&r.includes(h[0])||d[1]>0&&r.includes(h[1])||d[2]>0&&r.includes(h[2])||d[3]>0&&r.includes(h[3]))continue;const c=n[a],p=i[a];if(c[0]>0&&r.includes(p[0])||c[1]>0&&r.includes(p[1])||c[2]>0&&r.includes(p[2])||c[3]>0&&r.includes(p[3]))continue;const f=n[u],m=i[u];f[0]>0&&r.includes(m[0])||f[1]>0&&r.includes(m[1])||f[2]>0&&r.includes(m[2])||f[3]>0&&r.includes(m[3])||(t[o++]=l,t[o++]=a,t[o++]=u)}return o}_createErasedMesh(t,n){const i=new wr(t.geometry.clone(),t.material);i.name=`${t.name}(erase)`,i.frustumCulled=t.frustumCulled,i.layers.set(this._firstPersonOnlyLayer);const r=i.geometry,o=r.getAttribute("skinIndex"),s=o instanceof Mn?[]:o.array,l=[];for(let m=0;m<s.length;m+=4)l.push([s[m],s[m+1],s[m+2],s[m+3]]);const a=r.getAttribute("skinWeight"),u=a instanceof Mn?[]:a.array,d=[];for(let m=0;m<u.length;m+=4)d.push([u[m],u[m+1],u[m+2],u[m+3]]);const h=r.getIndex();if(!h)throw new Error("The geometry doesn't have an index buffer");const c=Array.from(h.array),p=this._excludeTriangles(c,d,l,n),f=[];for(let m=0;m<p;m++)f[m]=c[m];return r.setIndex(f),t.onBeforeRender&&(i.onBeforeRender=t.onBeforeRender),i.bind(new Pt(t.skeleton.bones,t.skeleton.boneInverses),new j),i}_createHeadlessModelForSkinnedMesh(t,n){const i=[];if(n.skeleton.bones.forEach((o,s)=>{this._isEraseTarget(o)&&i.push(s)}),!i.length){n.layers.enable(this._thirdPersonOnlyLayer),n.layers.enable(this._firstPersonOnlyLayer);return}n.layers.set(this._thirdPersonOnlyLayer);const r=this._createErasedMesh(n,i);t.add(r)}_createHeadlessModel(t){if(t.type==="Group")if(t.layers.set(this._thirdPersonOnlyLayer),this._isEraseTarget(t))t.traverse(n=>n.layers.set(this._thirdPersonOnlyLayer));else{const n=new pe;n.name=`_headless_${t.name}`,n.layers.set(this._firstPersonOnlyLayer),t.parent.add(n),t.children.filter(i=>i.type==="SkinnedMesh").forEach(i=>{const r=i;this._createHeadlessModelForSkinnedMesh(n,r)})}else if(t.type==="SkinnedMesh"){const n=t;this._createHeadlessModelForSkinnedMesh(t.parent,n)}else this._isEraseTarget(t)&&(t.layers.set(this._thirdPersonOnlyLayer),t.traverse(n=>n.layers.set(this._thirdPersonOnlyLayer)))}_isEraseTarget(t){return t===this.humanoid.getRawBoneNode("head")?!0:t.parent?this._isEraseTarget(t.parent):!1}};Nt.DEFAULT_FIRSTPERSON_ONLY_LAYER=9;Nt.DEFAULT_THIRDPERSON_ONLY_LAYER=10;var pt=Nt,$r=new Set(["1.0","1.0-beta"]),Ct=class{get name(){return"VRMFirstPersonLoaderPlugin"}constructor(e){this.parser=e}afterRoot(e){return S(this,null,function*(){const t=e.userData.vrmHumanoid;if(t!==null){if(t===void 0)throw new Error("VRMFirstPersonLoaderPlugin: vrmHumanoid is undefined. VRMHumanoidLoaderPlugin have to be used first");e.userData.vrmFirstPerson=yield this._import(e,t)}})}_import(e,t){return S(this,null,function*(){if(t==null)return null;const n=yield this._v1Import(e,t);if(n)return n;const i=yield this._v0Import(e,t);return i||null})}_v1Import(e,t){return S(this,null,function*(){var n,i;const r=this.parser.json;if(!(((n=r.extensionsUsed)==null?void 0:n.indexOf("VRMC_vrm"))!==-1))return null;const s=(i=r.extensions)==null?void 0:i.VRMC_vrm;if(!s)return null;const l=s.specVersion;if(!$r.has(l))return console.warn(`VRMFirstPersonLoaderPlugin: Unknown VRMC_vrm specVersion "${l}"`),null;const a=s.firstPerson,u=[],d=yield Sn(e);return Array.from(d.entries()).forEach(([h,c])=>{var p,f;const m=(p=a?.meshAnnotations)==null?void 0:p.find(g=>g.node===h);u.push({meshes:c,type:(f=m?.type)!=null?f:"auto"})}),new pt(t,u)})}_v0Import(e,t){return S(this,null,function*(){var n;const i=this.parser.json,r=(n=i.extensions)==null?void 0:n.VRM;if(!r)return null;const o=r.firstPerson;if(!o)return null;const s=[],l=yield Sn(e);return Array.from(l.entries()).forEach(([a,u])=>{const d=i.nodes[a],h=o.meshAnnotations?o.meshAnnotations.find(c=>c.mesh===d.mesh):void 0;s.push({meshes:u,type:this._convertV0FlagToV1Type(h?.firstPersonFlag)})}),new pt(t,s)})}_convertV0FlagToV1Type(e){return e==="FirstPersonOnly"?"firstPersonOnly":e==="ThirdPersonOnly"?"thirdPersonOnly":e==="Both"?"both":"auto"}},Zr={Auto:"auto",Both:"both",ThirdPersonOnly:"thirdPersonOnly",FirstPersonOnly:"firstPersonOnly"},Pn=new _,En=new _,Jr=new A,mt=class extends pe{constructor(e){super(),this.vrmHumanoid=e,this._boneAxesMap=new Map,Object.values(e.humanBones).forEach(t=>{const n=new Sr(1);n.matrixAutoUpdate=!1,n.material.depthTest=!1,n.material.depthWrite=!1,this.add(n),this._boneAxesMap.set(t,n)})}dispose(){Array.from(this._boneAxesMap.values()).forEach(e=>{e.geometry.dispose(),e.material.dispose()})}updateMatrixWorld(e){Array.from(this._boneAxesMap.entries()).forEach(([t,n])=>{t.node.updateWorldMatrix(!0,!1),t.node.matrixWorld.decompose(Pn,Jr,En);const i=Pn.set(.1,.1,.1).divide(En);n.matrix.copy(t.node.matrixWorld).scale(i)}),super.updateMatrixWorld(e)}},Ce=["hips","spine","chest","upperChest","neck","head","leftEye","rightEye","jaw","leftUpperLeg","leftLowerLeg","leftFoot","leftToes","rightUpperLeg","rightLowerLeg","rightFoot","rightToes","leftShoulder","leftUpperArm","leftLowerArm","leftHand","rightShoulder","rightUpperArm","rightLowerArm","rightHand","leftThumbMetacarpal","leftThumbProximal","leftThumbDistal","leftIndexProximal","leftIndexIntermediate","leftIndexDistal","leftMiddleProximal","leftMiddleIntermediate","leftMiddleDistal","leftRingProximal","leftRingIntermediate","leftRingDistal","leftLittleProximal","leftLittleIntermediate","leftLittleDistal","rightThumbMetacarpal","rightThumbProximal","rightThumbDistal","rightIndexProximal","rightIndexIntermediate","rightIndexDistal","rightMiddleProximal","rightMiddleIntermediate","rightMiddleDistal","rightRingProximal","rightRingIntermediate","rightRingDistal","rightLittleProximal","rightLittleIntermediate","rightLittleDistal"],Kr={Hips:"hips",Spine:"spine",Chest:"chest",UpperChest:"upperChest",Neck:"neck",Head:"head",LeftEye:"leftEye",RightEye:"rightEye",Jaw:"jaw",LeftUpperLeg:"leftUpperLeg",LeftLowerLeg:"leftLowerLeg",LeftFoot:"leftFoot",LeftToes:"leftToes",RightUpperLeg:"rightUpperLeg",RightLowerLeg:"rightLowerLeg",RightFoot:"rightFoot",RightToes:"rightToes",LeftShoulder:"leftShoulder",LeftUpperArm:"leftUpperArm",LeftLowerArm:"leftLowerArm",LeftHand:"leftHand",RightShoulder:"rightShoulder",RightUpperArm:"rightUpperArm",RightLowerArm:"rightLowerArm",RightHand:"rightHand",LeftThumbMetacarpal:"leftThumbMetacarpal",LeftThumbProximal:"leftThumbProximal",LeftThumbDistal:"leftThumbDistal",LeftIndexProximal:"leftIndexProximal",LeftIndexIntermediate:"leftIndexIntermediate",LeftIndexDistal:"leftIndexDistal",LeftMiddleProximal:"leftMiddleProximal",LeftMiddleIntermediate:"leftMiddleIntermediate",LeftMiddleDistal:"leftMiddleDistal",LeftRingProximal:"leftRingProximal",LeftRingIntermediate:"leftRingIntermediate",LeftRingDistal:"leftRingDistal",LeftLittleProximal:"leftLittleProximal",LeftLittleIntermediate:"leftLittleIntermediate",LeftLittleDistal:"leftLittleDistal",RightThumbMetacarpal:"rightThumbMetacarpal",RightThumbProximal:"rightThumbProximal",RightThumbDistal:"rightThumbDistal",RightIndexProximal:"rightIndexProximal",RightIndexIntermediate:"rightIndexIntermediate",RightIndexDistal:"rightIndexDistal",RightMiddleProximal:"rightMiddleProximal",RightMiddleIntermediate:"rightMiddleIntermediate",RightMiddleDistal:"rightMiddleDistal",RightRingProximal:"rightRingProximal",RightRingIntermediate:"rightRingIntermediate",RightRingDistal:"rightRingDistal",RightLittleProximal:"rightLittleProximal",RightLittleIntermediate:"rightLittleIntermediate",RightLittleDistal:"rightLittleDistal"},ci={hips:null,spine:"hips",chest:"spine",upperChest:"chest",neck:"upperChest",head:"neck",leftEye:"head",rightEye:"head",jaw:"head",leftUpperLeg:"hips",leftLowerLeg:"leftUpperLeg",leftFoot:"leftLowerLeg",leftToes:"leftFoot",rightUpperLeg:"hips",rightLowerLeg:"rightUpperLeg",rightFoot:"rightLowerLeg",rightToes:"rightFoot",leftShoulder:"upperChest",leftUpperArm:"leftShoulder",leftLowerArm:"leftUpperArm",leftHand:"leftLowerArm",rightShoulder:"upperChest",rightUpperArm:"rightShoulder",rightLowerArm:"rightUpperArm",rightHand:"rightLowerArm",leftThumbMetacarpal:"leftHand",leftThumbProximal:"leftThumbMetacarpal",leftThumbDistal:"leftThumbProximal",leftIndexProximal:"leftHand",leftIndexIntermediate:"leftIndexProximal",leftIndexDistal:"leftIndexIntermediate",leftMiddleProximal:"leftHand",leftMiddleIntermediate:"leftMiddleProximal",leftMiddleDistal:"leftMiddleIntermediate",leftRingProximal:"leftHand",leftRingIntermediate:"leftRingProximal",leftRingDistal:"leftRingIntermediate",leftLittleProximal:"leftHand",leftLittleIntermediate:"leftLittleProximal",leftLittleDistal:"leftLittleIntermediate",rightThumbMetacarpal:"rightHand",rightThumbProximal:"rightThumbMetacarpal",rightThumbDistal:"rightThumbProximal",rightIndexProximal:"rightHand",rightIndexIntermediate:"rightIndexProximal",rightIndexDistal:"rightIndexIntermediate",rightMiddleProximal:"rightHand",rightMiddleIntermediate:"rightMiddleProximal",rightMiddleDistal:"rightMiddleIntermediate",rightRingProximal:"rightHand",rightRingIntermediate:"rightRingProximal",rightRingDistal:"rightRingIntermediate",rightLittleProximal:"rightHand",rightLittleIntermediate:"rightLittleProximal",rightLittleDistal:"rightLittleIntermediate"};function pi(e){return e.invert?e.invert():e.inverse(),e}var Z=new _,J=new A,ft=class{constructor(e){this.humanBones=e,this.restPose=this.getAbsolutePose()}getAbsolutePose(){const e={};return Object.keys(this.humanBones).forEach(t=>{const n=t,i=this.getBoneNode(n);i&&(Z.copy(i.position),J.copy(i.quaternion),e[n]={position:Z.toArray(),rotation:J.toArray()})}),e}getPose(){const e={};return Object.keys(this.humanBones).forEach(t=>{const n=t,i=this.getBoneNode(n);if(!i)return;Z.set(0,0,0),J.identity();const r=this.restPose[n];r?.position&&Z.fromArray(r.position).negate(),r?.rotation&&pi(J.fromArray(r.rotation)),Z.add(i.position),J.premultiply(i.quaternion),e[n]={position:Z.toArray(),rotation:J.toArray()}}),e}setPose(e){Object.entries(e).forEach(([t,n])=>{const i=t,r=this.getBoneNode(i);if(!r)return;const o=this.restPose[i];o&&(n?.position&&(r.position.fromArray(n.position),o.position&&r.position.add(Z.fromArray(o.position))),n?.rotation&&(r.quaternion.fromArray(n.rotation),o.rotation&&r.quaternion.multiply(J.fromArray(o.rotation))))})}resetPose(){Object.entries(this.restPose).forEach(([e,t])=>{const n=this.getBoneNode(e);n&&(t?.position&&n.position.fromArray(t.position),t?.rotation&&n.quaternion.fromArray(t.rotation))})}getBone(e){var t;return(t=this.humanBones[e])!=null?t:void 0}getBoneNode(e){var t,n;return(n=(t=this.humanBones[e])==null?void 0:t.node)!=null?n:null}},et=new _,eo=new A,to=new _,Ln=class mi extends ft{static _setupTransforms(t){const n=new Be;n.name="VRMHumanoidRig";const i={},r={},o={};Ce.forEach(l=>{var a;const u=t.getBoneNode(l);if(u){const d=new _,h=new A;u.updateWorldMatrix(!0,!1),u.matrixWorld.decompose(d,h,et),i[l]=d,r[l]=u.quaternion.clone();const c=new A;(a=u.parent)==null||a.matrixWorld.decompose(et,c,et),o[l]=c}});const s={};return Ce.forEach(l=>{var a;const u=t.getBoneNode(l);if(u){const d=i[l];let h=l,c;for(;c==null&&(h=ci[h],h!=null);)c=i[h];const p=new Be;p.name="Normalized_"+u.name,(h?(a=s[h])==null?void 0:a.node:n).add(p),p.position.copy(d),c&&p.position.sub(c),s[l]={node:p}}}),{rigBones:s,root:n,parentWorldRotations:o,boneRotations:r}}constructor(t){const{rigBones:n,root:i,parentWorldRotations:r,boneRotations:o}=mi._setupTransforms(t);super(n),this.original=t,this.root=i,this._parentWorldRotations=r,this._boneRotations=o}update(){Ce.forEach(t=>{const n=this.original.getBoneNode(t);if(n!=null){const i=this.getBoneNode(t),r=this._parentWorldRotations[t],o=eo.copy(r).invert(),s=this._boneRotations[t];if(n.quaternion.copy(i.quaternion).multiply(r).premultiply(o).multiply(s),t==="hips"){const l=i.getWorldPosition(to);n.parent.updateWorldMatrix(!0,!1);const a=n.parent.matrixWorld,u=l.applyMatrix4(a.invert());n.position.copy(u)}}})}},gt=class fi{get restPose(){return console.warn("VRMHumanoid: restPose is deprecated. Use either rawRestPose or normalizedRestPose instead."),this.rawRestPose}get rawRestPose(){return this._rawHumanBones.restPose}get normalizedRestPose(){return this._normalizedHumanBones.restPose}get humanBones(){return this._rawHumanBones.humanBones}get rawHumanBones(){return this._rawHumanBones.humanBones}get normalizedHumanBones(){return this._normalizedHumanBones.humanBones}get normalizedHumanBonesRoot(){return this._normalizedHumanBones.root}constructor(t,n){var i;this.autoUpdateHumanBones=(i=n?.autoUpdateHumanBones)!=null?i:!0,this._rawHumanBones=new ft(t),this._normalizedHumanBones=new Ln(this._rawHumanBones)}copy(t){return this.autoUpdateHumanBones=t.autoUpdateHumanBones,this._rawHumanBones=new ft(t.humanBones),this._normalizedHumanBones=new Ln(this._rawHumanBones),this}clone(){return new fi(this.humanBones,{autoUpdateHumanBones:this.autoUpdateHumanBones}).copy(this)}getAbsolutePose(){return console.warn("VRMHumanoid: getAbsolutePose() is deprecated. Use either getRawAbsolutePose() or getNormalizedAbsolutePose() instead."),this.getRawAbsolutePose()}getRawAbsolutePose(){return this._rawHumanBones.getAbsolutePose()}getNormalizedAbsolutePose(){return this._normalizedHumanBones.getAbsolutePose()}getPose(){return console.warn("VRMHumanoid: getPose() is deprecated. Use either getRawPose() or getNormalizedPose() instead."),this.getRawPose()}getRawPose(){return this._rawHumanBones.getPose()}getNormalizedPose(){return this._normalizedHumanBones.getPose()}setPose(t){return console.warn("VRMHumanoid: setPose() is deprecated. Use either setRawPose() or setNormalizedPose() instead."),this.setRawPose(t)}setRawPose(t){return this._rawHumanBones.setPose(t)}setNormalizedPose(t){return this._normalizedHumanBones.setPose(t)}resetPose(){return console.warn("VRMHumanoid: resetPose() is deprecated. Use either resetRawPose() or resetNormalizedPose() instead."),this.resetRawPose()}resetRawPose(){return this._rawHumanBones.resetPose()}resetNormalizedPose(){return this._normalizedHumanBones.resetPose()}getBone(t){return console.warn("VRMHumanoid: getBone() is deprecated. Use either getRawBone() or getNormalizedBone() instead."),this.getRawBone(t)}getRawBone(t){return this._rawHumanBones.getBone(t)}getNormalizedBone(t){return this._normalizedHumanBones.getBone(t)}getBoneNode(t){return console.warn("VRMHumanoid: getBoneNode() is deprecated. Use either getRawBoneNode() or getNormalizedBoneNode() instead."),this.getRawBoneNode(t)}getRawBoneNode(t){return this._rawHumanBones.getBoneNode(t)}getNormalizedBoneNode(t){return this._normalizedHumanBones.getBoneNode(t)}update(){this.autoUpdateHumanBones&&this._normalizedHumanBones.update()}},gi={Hips:"hips",Spine:"spine",Head:"head",LeftUpperLeg:"leftUpperLeg",LeftLowerLeg:"leftLowerLeg",LeftFoot:"leftFoot",RightUpperLeg:"rightUpperLeg",RightLowerLeg:"rightLowerLeg",RightFoot:"rightFoot",LeftUpperArm:"leftUpperArm",LeftLowerArm:"leftLowerArm",LeftHand:"leftHand",RightUpperArm:"rightUpperArm",RightLowerArm:"rightLowerArm",RightHand:"rightHand"},no=new Set(["1.0","1.0-beta"]),bn={leftThumbProximal:"leftThumbMetacarpal",leftThumbIntermediate:"leftThumbProximal",rightThumbProximal:"rightThumbMetacarpal",rightThumbIntermediate:"rightThumbProximal"},Ot=class{get name(){return"VRMHumanoidLoaderPlugin"}constructor(e,t){this.parser=e,this.helperRoot=t?.helperRoot,this.autoUpdateHumanBones=t?.autoUpdateHumanBones}afterRoot(e){return S(this,null,function*(){e.userData.vrmHumanoid=yield this._import(e)})}_import(e){return S(this,null,function*(){const t=yield this._v1Import(e);if(t)return t;const n=yield this._v0Import(e);return n||null})}_v1Import(e){return S(this,null,function*(){var t,n;const i=this.parser.json;if(!(((t=i.extensionsUsed)==null?void 0:t.indexOf("VRMC_vrm"))!==-1))return null;const o=(n=i.extensions)==null?void 0:n.VRMC_vrm;if(!o)return null;const s=o.specVersion;if(!no.has(s))return console.warn(`VRMHumanoidLoaderPlugin: Unknown VRMC_vrm specVersion "${s}"`),null;const l=o.humanoid;if(!l)return null;const a=l.humanBones.leftThumbIntermediate!=null||l.humanBones.rightThumbIntermediate!=null,u={};l.humanBones!=null&&(yield Promise.all(Object.entries(l.humanBones).map(h=>S(this,[h],function*([c,p]){let f=c;const m=p.node;if(a){const v=bn[f];v!=null&&(f=v)}const g=yield this.parser.getDependency("node",m);if(g==null){console.warn(`A glTF node bound to the humanoid bone ${f} (index = ${m}) does not exist`);return}u[f]={node:g}}))));const d=new gt(this._ensureRequiredBonesExist(u),{autoUpdateHumanBones:this.autoUpdateHumanBones});if(e.scene.add(d.normalizedHumanBonesRoot),this.helperRoot){const h=new mt(d);this.helperRoot.add(h),h.renderOrder=this.helperRoot.renderOrder}return d})}_v0Import(e){return S(this,null,function*(){var t;const i=(t=this.parser.json.extensions)==null?void 0:t.VRM;if(!i)return null;const r=i.humanoid;if(!r)return null;const o={};r.humanBones!=null&&(yield Promise.all(r.humanBones.map(l=>S(this,null,function*(){const a=l.bone,u=l.node;if(a==null||u==null)return;if(u<0){console.warn(`A glTF node index for the humanoid bone ${a} is negative (${u}), ignoring this bone.`);return}const d=yield this.parser.getDependency("node",u);if(d==null){console.warn(`A glTF node bound to the humanoid bone ${a} (index = ${u}) does not exist`);return}const h=bn[a],c=h??a;if(o[c]!=null){console.warn(`Multiple bone entries for ${c} detected (index = ${u}), ignoring duplicated entries.`);return}o[c]={node:d}}))));const s=new gt(this._ensureRequiredBonesExist(o),{autoUpdateHumanBones:this.autoUpdateHumanBones});if(e.scene.add(s.normalizedHumanBonesRoot),this.helperRoot){const l=new mt(s);this.helperRoot.add(l),l.renderOrder=this.helperRoot.renderOrder}return s})}_ensureRequiredBonesExist(e){const t=Object.values(gi).filter(n=>e[n]==null);if(t.length>0)throw new Error(`VRMHumanoidLoaderPlugin: These humanoid bones are required but not exist: ${t.join(", ")}`);return e}},In=class extends Y{constructor(){super(),this._currentTheta=0,this._currentRadius=0,this.theta=0,this.radius=0,this._currentTheta=0,this._currentRadius=0,this._attrPos=new U(new Float32Array(195),3),this.setAttribute("position",this._attrPos),this._attrIndex=new U(new Uint16Array(189),1),this.setIndex(this._attrIndex),this._buildIndex(),this.update()}update(){let e=!1;this._currentTheta!==this.theta&&(this._currentTheta=this.theta,e=!0),this._currentRadius!==this.radius&&(this._currentRadius=this.radius,e=!0),e&&this._buildPosition()}_buildPosition(){this._attrPos.setXYZ(0,0,0,0);for(let e=0;e<64;e++){const t=e/63*this._currentTheta;this._attrPos.setXYZ(e+1,this._currentRadius*Math.sin(t),0,this._currentRadius*Math.cos(t))}this._attrPos.needsUpdate=!0}_buildIndex(){for(let e=0;e<63;e++)this._attrIndex.setXYZ(e*3,0,e+1,e+2);this._attrIndex.needsUpdate=!0}},io=class extends Y{constructor(){super(),this.radius=0,this._currentRadius=0,this.tail=new _,this._currentTail=new _,this._attrPos=new U(new Float32Array(294),3),this.setAttribute("position",this._attrPos),this._attrIndex=new U(new Uint16Array(194),1),this.setIndex(this._attrIndex),this._buildIndex(),this.update()}update(){let e=!1;this._currentRadius!==this.radius&&(this._currentRadius=this.radius,e=!0),this._currentTail.equals(this.tail)||(this._currentTail.copy(this.tail),e=!0),e&&this._buildPosition()}_buildPosition(){for(let e=0;e<32;e++){const t=e/16*Math.PI;this._attrPos.setXYZ(e,Math.cos(t),Math.sin(t),0),this._attrPos.setXYZ(32+e,0,Math.cos(t),Math.sin(t)),this._attrPos.setXYZ(64+e,Math.sin(t),0,Math.cos(t))}this.scale(this._currentRadius,this._currentRadius,this._currentRadius),this.translate(this._currentTail.x,this._currentTail.y,this._currentTail.z),this._attrPos.setXYZ(96,0,0,0),this._attrPos.setXYZ(97,this._currentTail.x,this._currentTail.y,this._currentTail.z),this._attrPos.needsUpdate=!0}_buildIndex(){for(let e=0;e<32;e++){const t=(e+1)%32;this._attrIndex.setXY(e*2,e,t),this._attrIndex.setXY(64+e*2,32+e,32+t),this._attrIndex.setXY(128+e*2,64+e,64+t)}this._attrIndex.setXY(192,96,97),this._attrIndex.needsUpdate=!0}},be=new A,Nn=new A,ve=new _,Cn=new _,On=Math.sqrt(2)/2,ro=new A(0,0,-On,On),oo=new _(0,1,0),_i=class extends pe{constructor(e){super(),this.matrixAutoUpdate=!1,this.vrmLookAt=e;{const t=new In;t.radius=.5;const n=new xn({color:65280,transparent:!0,opacity:.5,side:yn,depthTest:!1,depthWrite:!1});this._meshPitch=new Rn(t,n),this.add(this._meshPitch)}{const t=new In;t.radius=.5;const n=new xn({color:16711680,transparent:!0,opacity:.5,side:yn,depthTest:!1,depthWrite:!1});this._meshYaw=new Rn(t,n),this.add(this._meshYaw)}{const t=new io;t.radius=.1;const n=new Ye({color:16777215,depthTest:!1,depthWrite:!1});this._lineTarget=new Lt(t,n),this._lineTarget.frustumCulled=!1,this.add(this._lineTarget)}}dispose(){this._meshYaw.geometry.dispose(),this._meshYaw.material.dispose(),this._meshPitch.geometry.dispose(),this._meshPitch.material.dispose(),this._lineTarget.geometry.dispose(),this._lineTarget.material.dispose()}updateMatrixWorld(e){const t=N.DEG2RAD*this.vrmLookAt.yaw;this._meshYaw.geometry.theta=t,this._meshYaw.geometry.update();const n=N.DEG2RAD*this.vrmLookAt.pitch;this._meshPitch.geometry.theta=n,this._meshPitch.geometry.update(),this.vrmLookAt.getLookAtWorldPosition(ve),this.vrmLookAt.getLookAtWorldQuaternion(be),be.multiply(this.vrmLookAt.getFaceFrontQuaternion(Nn)),this._meshYaw.position.copy(ve),this._meshYaw.quaternion.copy(be),this._meshPitch.position.copy(ve),this._meshPitch.quaternion.copy(be),this._meshPitch.quaternion.multiply(Nn.setFromAxisAngle(oo,t)),this._meshPitch.quaternion.multiply(ro);const{target:i,autoUpdate:r}=this.vrmLookAt;i!=null&&r&&(i.getWorldPosition(Cn).sub(ve),this._lineTarget.geometry.tail.copy(Cn),this._lineTarget.geometry.update(),this._lineTarget.position.copy(ve)),super.updateMatrixWorld(e)}},so=new _,ao=new _;function _t(e,t){return e.matrixWorld.decompose(so,t,ao),t}function Oe(e){return[Math.atan2(-e.z,e.x),Math.atan2(e.y,Math.sqrt(e.x*e.x+e.z*e.z))]}function Un(e){const t=Math.round(e/2/Math.PI);return e-2*Math.PI*t}var Vn=new _(0,0,1),lo=new _,uo=new _,ho=new _,co=new A,tt=new A,Fn=new A,po=new A,nt=new Et,vi=class Mi{constructor(t,n){this.offsetFromHeadBone=new _,this.autoUpdate=!0,this.faceFront=new _(0,0,1),this.humanoid=t,this.applier=n,this._yaw=0,this._pitch=0,this._needsUpdate=!0,this._restHeadWorldQuaternion=this.getLookAtWorldQuaternion(new A)}get yaw(){return this._yaw}set yaw(t){this._yaw=t,this._needsUpdate=!0}get pitch(){return this._pitch}set pitch(t){this._pitch=t,this._needsUpdate=!0}get euler(){return console.warn("VRMLookAt: euler is deprecated. use getEuler() instead."),this.getEuler(new Et)}getEuler(t){return t.set(N.DEG2RAD*this._pitch,N.DEG2RAD*this._yaw,0,"YXZ")}copy(t){if(this.humanoid!==t.humanoid)throw new Error("VRMLookAt: humanoid must be same in order to copy");return this.offsetFromHeadBone.copy(t.offsetFromHeadBone),this.applier=t.applier,this.autoUpdate=t.autoUpdate,this.target=t.target,this.faceFront.copy(t.faceFront),this}clone(){return new Mi(this.humanoid,this.applier).copy(this)}reset(){this._yaw=0,this._pitch=0,this._needsUpdate=!0}getLookAtWorldPosition(t){const n=this.humanoid.getRawBoneNode("head");return t.copy(this.offsetFromHeadBone).applyMatrix4(n.matrixWorld)}getLookAtWorldQuaternion(t){const n=this.humanoid.getRawBoneNode("head");return _t(n,t)}getFaceFrontQuaternion(t){if(this.faceFront.distanceToSquared(Vn)<.01)return t.copy(this._restHeadWorldQuaternion).invert();const[n,i]=Oe(this.faceFront);return nt.set(0,.5*Math.PI+n,i,"YZX"),t.setFromEuler(nt).premultiply(po.copy(this._restHeadWorldQuaternion).invert())}getLookAtWorldDirection(t){return this.getLookAtWorldQuaternion(tt),this.getFaceFrontQuaternion(Fn),t.copy(Vn).applyQuaternion(tt).applyQuaternion(Fn).applyEuler(this.getEuler(nt))}lookAt(t){const n=co.copy(this._restHeadWorldQuaternion).multiply(pi(this.getLookAtWorldQuaternion(tt))),i=this.getLookAtWorldPosition(uo),r=ho.copy(t).sub(i).applyQuaternion(n).normalize(),[o,s]=Oe(this.faceFront),[l,a]=Oe(r),u=Un(l-o),d=Un(s-a);this._yaw=N.RAD2DEG*u,this._pitch=N.RAD2DEG*d,this._needsUpdate=!0}update(t){this.target!=null&&this.autoUpdate&&this.lookAt(this.target.getWorldPosition(lo)),this._needsUpdate&&(this._needsUpdate=!1,this.applier.applyYawPitch(this._yaw,this._pitch))}};vi.EULER_ORDER="YXZ";var xi=vi,mo=new _(0,0,1),B=new A,se=new A,F=new Et(0,0,0,"YXZ"),we=class{constructor(e,t,n,i,r){this.humanoid=e,this.rangeMapHorizontalInner=t,this.rangeMapHorizontalOuter=n,this.rangeMapVerticalDown=i,this.rangeMapVerticalUp=r,this.faceFront=new _(0,0,1),this._restQuatLeftEye=new A,this._restQuatRightEye=new A,this._restLeftEyeParentWorldQuat=new A,this._restRightEyeParentWorldQuat=new A;const o=this.humanoid.getRawBoneNode("leftEye"),s=this.humanoid.getRawBoneNode("rightEye");o&&(this._restQuatLeftEye.copy(o.quaternion),_t(o.parent,this._restLeftEyeParentWorldQuat)),s&&(this._restQuatRightEye.copy(s.quaternion),_t(s.parent,this._restRightEyeParentWorldQuat))}applyYawPitch(e,t){const n=this.humanoid.getRawBoneNode("leftEye"),i=this.humanoid.getRawBoneNode("rightEye"),r=this.humanoid.getNormalizedBoneNode("leftEye"),o=this.humanoid.getNormalizedBoneNode("rightEye");n&&(t<0?F.x=-N.DEG2RAD*this.rangeMapVerticalDown.map(-t):F.x=N.DEG2RAD*this.rangeMapVerticalUp.map(t),e<0?F.y=-N.DEG2RAD*this.rangeMapHorizontalInner.map(-e):F.y=N.DEG2RAD*this.rangeMapHorizontalOuter.map(e),B.setFromEuler(F),this._getWorldFaceFrontQuat(se),r.quaternion.copy(se).multiply(B).multiply(se.invert()),B.copy(this._restLeftEyeParentWorldQuat),n.quaternion.copy(r.quaternion).multiply(B).premultiply(B.invert()).multiply(this._restQuatLeftEye)),i&&(t<0?F.x=-N.DEG2RAD*this.rangeMapVerticalDown.map(-t):F.x=N.DEG2RAD*this.rangeMapVerticalUp.map(t),e<0?F.y=-N.DEG2RAD*this.rangeMapHorizontalOuter.map(-e):F.y=N.DEG2RAD*this.rangeMapHorizontalInner.map(e),B.setFromEuler(F),this._getWorldFaceFrontQuat(se),o.quaternion.copy(se).multiply(B).multiply(se.invert()),B.copy(this._restRightEyeParentWorldQuat),i.quaternion.copy(o.quaternion).multiply(B).premultiply(B.invert()).multiply(this._restQuatRightEye))}lookAt(e){console.warn("VRMLookAtBoneApplier: lookAt() is deprecated. use apply() instead.");const t=N.RAD2DEG*e.y,n=N.RAD2DEG*e.x;this.applyYawPitch(t,n)}_getWorldFaceFrontQuat(e){if(this.faceFront.distanceToSquared(mo)<.01)return e.identity();const[t,n]=Oe(this.faceFront);return F.set(0,.5*Math.PI+t,n,"YZX"),e.setFromEuler(F)}};we.type="bone";var We=class{constructor(e,t,n,i,r){this.expressions=e,this.rangeMapHorizontalInner=t,this.rangeMapHorizontalOuter=n,this.rangeMapVerticalDown=i,this.rangeMapVerticalUp=r}applyYawPitch(e,t){t<0?(this.expressions.setValue("lookDown",0),this.expressions.setValue("lookUp",this.rangeMapVerticalUp.map(-t))):(this.expressions.setValue("lookUp",0),this.expressions.setValue("lookDown",this.rangeMapVerticalDown.map(t))),e<0?(this.expressions.setValue("lookLeft",0),this.expressions.setValue("lookRight",this.rangeMapHorizontalOuter.map(-e))):(this.expressions.setValue("lookRight",0),this.expressions.setValue("lookLeft",this.rangeMapHorizontalOuter.map(e)))}lookAt(e){console.warn("VRMLookAtBoneApplier: lookAt() is deprecated. use apply() instead.");const t=N.RAD2DEG*e.y,n=N.RAD2DEG*e.x;this.applyYawPitch(t,n)}};We.type="expression";var vt=class{constructor(e,t){this.inputMaxValue=e,this.outputScale=t}map(e){return this.outputScale*ri(e/this.inputMaxValue)}},fo=new Set(["1.0","1.0-beta"]),Ie=.01,Ut=class{get name(){return"VRMLookAtLoaderPlugin"}constructor(e,t){this.parser=e,this.helperRoot=t?.helperRoot}afterRoot(e){return S(this,null,function*(){const t=e.userData.vrmHumanoid;if(t===null)return;if(t===void 0)throw new Error("VRMLookAtLoaderPlugin: vrmHumanoid is undefined. VRMHumanoidLoaderPlugin have to be used first");const n=e.userData.vrmExpressionManager;if(n!==null){if(n===void 0)throw new Error("VRMLookAtLoaderPlugin: vrmExpressionManager is undefined. VRMExpressionLoaderPlugin have to be used first");e.userData.vrmLookAt=yield this._import(e,t,n)}})}_import(e,t,n){return S(this,null,function*(){if(t==null||n==null)return null;const i=yield this._v1Import(e,t,n);if(i)return i;const r=yield this._v0Import(e,t,n);return r||null})}_v1Import(e,t,n){return S(this,null,function*(){var i,r,o;const s=this.parser.json;if(!(((i=s.extensionsUsed)==null?void 0:i.indexOf("VRMC_vrm"))!==-1))return null;const a=(r=s.extensions)==null?void 0:r.VRMC_vrm;if(!a)return null;const u=a.specVersion;if(!fo.has(u))return console.warn(`VRMLookAtLoaderPlugin: Unknown VRMC_vrm specVersion "${u}"`),null;const d=a.lookAt;if(!d)return null;const h=d.type==="expression"?1:10,c=this._v1ImportRangeMap(d.rangeMapHorizontalInner,h),p=this._v1ImportRangeMap(d.rangeMapHorizontalOuter,h),f=this._v1ImportRangeMap(d.rangeMapVerticalDown,h),m=this._v1ImportRangeMap(d.rangeMapVerticalUp,h);let g;d.type==="expression"?g=new We(n,c,p,f,m):g=new we(t,c,p,f,m);const v=this._importLookAt(t,g);return v.offsetFromHeadBone.fromArray((o=d.offsetFromHeadBone)!=null?o:[0,.06,0]),v})}_v1ImportRangeMap(e,t){var n,i;let r=(n=e?.inputMaxValue)!=null?n:90;const o=(i=e?.outputScale)!=null?i:t;return r<Ie&&(console.warn("VRMLookAtLoaderPlugin: inputMaxValue of a range map is too small. Consider reviewing the range map!"),r=Ie),new vt(r,o)}_v0Import(e,t,n){return S(this,null,function*(){var i,r,o,s;const a=(i=this.parser.json.extensions)==null?void 0:i.VRM;if(!a)return null;const u=a.firstPerson;if(!u)return null;const d=u.lookAtTypeName==="BlendShape"?1:10,h=this._v0ImportDegreeMap(u.lookAtHorizontalInner,d),c=this._v0ImportDegreeMap(u.lookAtHorizontalOuter,d),p=this._v0ImportDegreeMap(u.lookAtVerticalDown,d),f=this._v0ImportDegreeMap(u.lookAtVerticalUp,d);let m;u.lookAtTypeName==="BlendShape"?m=new We(n,h,c,p,f):m=new we(t,h,c,p,f);const g=this._importLookAt(t,m);return u.firstPersonBoneOffset?g.offsetFromHeadBone.set((r=u.firstPersonBoneOffset.x)!=null?r:0,(o=u.firstPersonBoneOffset.y)!=null?o:.06,-((s=u.firstPersonBoneOffset.z)!=null?s:0)):g.offsetFromHeadBone.set(0,.06,0),g.faceFront.set(0,0,-1),m instanceof we&&m.faceFront.set(0,0,-1),g})}_v0ImportDegreeMap(e,t){var n,i;const r=e?.curve;JSON.stringify(r)!=="[0,0,0,1,1,1,1,0]"&&console.warn("Curves of LookAtDegreeMap defined in VRM 0.0 are not supported");let o=(n=e?.xRange)!=null?n:90;const s=(i=e?.yRange)!=null?i:t;return o<Ie&&(console.warn("VRMLookAtLoaderPlugin: xRange of a degree map is too small. Consider reviewing the degree map!"),o=Ie),new vt(o,s)}_importLookAt(e,t){const n=new xi(e,t);if(this.helperRoot){const i=new _i(n);this.helperRoot.add(i),i.renderOrder=this.helperRoot.renderOrder}return n}},go={Bone:"bone",Expression:"expression"};function _o(e,t){return typeof e!="string"||e===""?"":(/^https?:\/\//i.test(t)&&/^\//.test(e)&&(t=t.replace(/(^https?:\/\/[^/]+).*/i,"$1")),/^(https?:)?\/\//i.test(e)||/^data:.*,.*$/i.test(e)||/^blob:.*$/i.test(e)?e:t+e)}var vo=new Set(["1.0","1.0-beta"]),Vt=class{get name(){return"VRMMetaLoaderPlugin"}constructor(e,t){var n,i,r;this.parser=e,this.needThumbnailImage=(n=t?.needThumbnailImage)!=null?n:!1,this.acceptLicenseUrls=(i=t?.acceptLicenseUrls)!=null?i:["https://vrm.dev/licenses/1.0/"],this.acceptV0Meta=(r=t?.acceptV0Meta)!=null?r:!0}afterRoot(e){return S(this,null,function*(){e.userData.vrmMeta=yield this._import(e)})}_import(e){return S(this,null,function*(){const t=yield this._v1Import(e);if(t!=null)return t;const n=yield this._v0Import(e);return n??null})}_v1Import(e){return S(this,null,function*(){var t,n,i;const r=this.parser.json;if(!(((t=r.extensionsUsed)==null?void 0:t.indexOf("VRMC_vrm"))!==-1))return null;const s=(n=r.extensions)==null?void 0:n.VRMC_vrm;if(s==null)return null;const l=s.specVersion;if(!vo.has(l))return console.warn(`VRMMetaLoaderPlugin: Unknown VRMC_vrm specVersion "${l}"`),null;const a=s.meta;if(!a)return null;const u=a.licenseUrl;if(!new Set(this.acceptLicenseUrls).has(u))throw new Error(`VRMMetaLoaderPlugin: The license url "${u}" is not accepted`);let h;return this.needThumbnailImage&&a.thumbnailImage!=null&&(h=(i=yield this._extractGLTFImage(a.thumbnailImage))!=null?i:void 0),{metaVersion:"1",name:a.name,version:a.version,authors:a.authors,copyrightInformation:a.copyrightInformation,contactInformation:a.contactInformation,references:a.references,thirdPartyLicenses:a.thirdPartyLicenses,thumbnailImage:h,licenseUrl:a.licenseUrl,avatarPermission:a.avatarPermission,allowExcessivelyViolentUsage:a.allowExcessivelyViolentUsage,allowExcessivelySexualUsage:a.allowExcessivelySexualUsage,commercialUsage:a.commercialUsage,allowPoliticalOrReligiousUsage:a.allowPoliticalOrReligiousUsage,allowAntisocialOrHateUsage:a.allowAntisocialOrHateUsage,creditNotation:a.creditNotation,allowRedistribution:a.allowRedistribution,modification:a.modification,otherLicenseUrl:a.otherLicenseUrl}})}_v0Import(e){return S(this,null,function*(){var t;const i=(t=this.parser.json.extensions)==null?void 0:t.VRM;if(!i)return null;const r=i.meta;if(!r)return null;if(!this.acceptV0Meta)throw new Error("VRMMetaLoaderPlugin: Attempted to load VRM0.0 meta but acceptV0Meta is false");let o;return this.needThumbnailImage&&r.texture!=null&&r.texture!==-1&&(o=yield this.parser.getDependency("texture",r.texture)),{metaVersion:"0",allowedUserName:r.allowedUserName,author:r.author,commercialUssageName:r.commercialUssageName,contactInformation:r.contactInformation,licenseName:r.licenseName,otherLicenseUrl:r.otherLicenseUrl,otherPermissionUrl:r.otherPermissionUrl,reference:r.reference,sexualUssageName:r.sexualUssageName,texture:o??void 0,title:r.title,version:r.version,violentUssageName:r.violentUssageName}})}_extractGLTFImage(e){return S(this,null,function*(){var t;const i=(t=this.parser.json.images)==null?void 0:t[e];if(i==null)return console.warn(`VRMMetaLoaderPlugin: Attempt to use images[${e}] of glTF as a thumbnail but the image doesn't exist`),null;let r=i.uri;if(i.bufferView!=null){const s=yield this.parser.getDependency("bufferView",i.bufferView),l=new Blob([s],{type:i.mimeType});r=URL.createObjectURL(l)}return r==null?(console.warn(`VRMMetaLoaderPlugin: Attempt to use images[${e}] of glTF as a thumbnail but the image couldn't load properly`),null):yield new Er().loadAsync(_o(r,this.parser.options.path)).catch(s=>(console.error(s),console.warn("VRMMetaLoaderPlugin: Failed to load a thumbnail image"),null))})}},Ft=class{constructor(e){this.scene=e.scene,this.meta=e.meta,this.humanoid=e.humanoid,this.expressionManager=e.expressionManager,this.firstPerson=e.firstPerson,this.lookAt=e.lookAt}update(e){this.humanoid.update(),this.lookAt&&this.lookAt.update(e),this.expressionManager&&this.expressionManager.update()}},Mo=class{get name(){return"VRMC_vrm"}constructor(e,t){var n,i,r,o,s;this.parser=e;const l=t?.helperRoot,a=t?.autoUpdateHumanBones;this.expressionPlugin=(n=t?.expressionPlugin)!=null?n:new It(e),this.firstPersonPlugin=(i=t?.firstPersonPlugin)!=null?i:new Ct(e),this.humanoidPlugin=(r=t?.humanoidPlugin)!=null?r:new Ot(e,{helperRoot:l,autoUpdateHumanBones:a}),this.lookAtPlugin=(o=t?.lookAtPlugin)!=null?o:new Ut(e,{helperRoot:l}),this.metaPlugin=(s=t?.metaPlugin)!=null?s:new Vt(e)}afterRoot(e){return S(this,null,function*(){yield this.metaPlugin.afterRoot(e),yield this.humanoidPlugin.afterRoot(e),yield this.expressionPlugin.afterRoot(e),yield this.lookAtPlugin.afterRoot(e),yield this.firstPersonPlugin.afterRoot(e);const t=e.userData.vrmMeta,n=e.userData.vrmHumanoid;if(t&&n){const i=new Ft({scene:e.scene,expressionManager:e.userData.vrmExpressionManager,firstPerson:e.userData.vrmFirstPerson,humanoid:n,lookAt:e.userData.vrmLookAt,meta:t});e.userData.vrmCore=i}})}},yi=class extends Ft{constructor(e){super(e),this.materials=e.materials,this.springBoneManager=e.springBoneManager,this.nodeConstraintManager=e.nodeConstraintManager}update(e){super.update(e),this.nodeConstraintManager&&this.nodeConstraintManager.update(),this.springBoneManager&&this.springBoneManager.update(e),this.materials&&this.materials.forEach(t=>{t.update&&t.update(e)})}},xo=Object.defineProperty,Dn=Object.getOwnPropertySymbols,yo=Object.prototype.hasOwnProperty,Ro=Object.prototype.propertyIsEnumerable,Bn=(e,t,n)=>t in e?xo(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n,Hn=(e,t)=>{for(var n in t||(t={}))yo.call(t,n)&&Bn(e,n,t[n]);if(Dn)for(var n of Dn(t))Ro.call(t,n)&&Bn(e,n,t[n]);return e},te=(e,t,n)=>new Promise((i,r)=>{var o=a=>{try{l(n.next(a))}catch(u){r(u)}},s=a=>{try{l(n.throw(a))}catch(u){r(u)}},l=a=>a.done?i(a.value):Promise.resolve(a.value).then(o,s);l((n=n.apply(e,t)).next())}),To={"":3e3,srgb:3001};function wo(e,t){parseInt(Q,10)>=152?e.colorSpace=t:e.encoding=To[t]}var So=class{get pending(){return Promise.all(this._pendings)}constructor(e,t){this._parser=e,this._materialParams=t,this._pendings=[]}assignPrimitive(e,t){t!=null&&(this._materialParams[e]=t)}assignColor(e,t,n){if(t!=null){const i=new O().fromArray(t);n&&i.convertSRGBToLinear(),this._materialParams[e]=i}}assignTexture(e,t,n){return te(this,null,function*(){const i=te(this,null,function*(){if(t!=null){const r=yield this._parser.assignTexture(this._materialParams,e,t);if(r==null){console.warn("GLTFMToonMaterialParamsAssignHelper: Failed to load texture. The rendering result may be wrong");return}n&&wo(r,"srgb")}});return this._pendings.push(i),i})}assignTextureByIndex(e,t,n){return te(this,null,function*(){return this.assignTexture(e,t!=null?{index:t}:void 0,n)})}},Ao=`// #define PHONG

varying vec3 vViewPosition;

#ifndef FLAT_SHADED
  varying vec3 vNormal;
#endif

#include <common>

// #include <uv_pars_vertex>
#ifdef MTOON_USE_UV
  varying vec2 vUv;

  // COMPAT: pre-r151 uses a common uvTransform
  #if THREE_VRM_THREE_REVISION < 151
    uniform mat3 uvTransform;
  #endif
#endif

// #include <uv2_pars_vertex>
// COMAPT: pre-r151 uses uv2 for lightMap and aoMap
#if THREE_VRM_THREE_REVISION < 151
  #if defined( USE_LIGHTMAP ) || defined( USE_AOMAP )
    attribute vec2 uv2;
    varying vec2 vUv2;
    uniform mat3 uv2Transform;
  #endif
#endif

// #include <displacementmap_pars_vertex>
// #include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>

#ifdef USE_OUTLINEWIDTHMULTIPLYTEXTURE
  uniform sampler2D outlineWidthMultiplyTexture;
  uniform mat3 outlineWidthMultiplyTextureUvTransform;
#endif

uniform float outlineWidthFactor;

void main() {

  // #include <uv_vertex>
  #ifdef MTOON_USE_UV
    // COMPAT: pre-r151 uses a common uvTransform
    #if THREE_VRM_THREE_REVISION >= 151
      vUv = uv;
    #else
      vUv = ( uvTransform * vec3( uv, 1 ) ).xy;
    #endif
  #endif

  // #include <uv2_vertex>
  // COMAPT: pre-r151 uses uv2 for lightMap and aoMap
  #if THREE_VRM_THREE_REVISION < 151
    #if defined( USE_LIGHTMAP ) || defined( USE_AOMAP )
      vUv2 = ( uv2Transform * vec3( uv2, 1 ) ).xy;
    #endif
  #endif

  #include <color_vertex>

  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>

  // we need this to compute the outline properly
  objectNormal = normalize( objectNormal );

  #include <defaultnormal_vertex>

  #ifndef FLAT_SHADED // Normal computed with derivatives when FLAT_SHADED
    vNormal = normalize( transformedNormal );
  #endif

  #include <begin_vertex>

  #include <morphtarget_vertex>
  #include <skinning_vertex>
  // #include <displacementmap_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>

  vViewPosition = - mvPosition.xyz;

  #ifdef OUTLINE
    float worldNormalLength = length( transformedNormal );
    vec3 outlineOffset = outlineWidthFactor * worldNormalLength * objectNormal;

    #ifdef USE_OUTLINEWIDTHMULTIPLYTEXTURE
      vec2 outlineWidthMultiplyTextureUv = ( outlineWidthMultiplyTextureUvTransform * vec3( vUv, 1 ) ).xy;
      float outlineTex = texture2D( outlineWidthMultiplyTexture, outlineWidthMultiplyTextureUv ).g;
      outlineOffset *= outlineTex;
    #endif

    #ifdef OUTLINE_WIDTH_SCREEN
      outlineOffset *= vViewPosition.z / projectionMatrix[ 1 ].y;
    #endif

    gl_Position = projectionMatrix * modelViewMatrix * vec4( outlineOffset + transformed, 1.0 );

    gl_Position.z += 1E-6 * gl_Position.w; // anti-artifact magic
  #endif

  #include <worldpos_vertex>
  // #include <envmap_vertex>
  #include <shadowmap_vertex>
  #include <fog_vertex>

}`,Po=`// #define PHONG

uniform vec3 litFactor;

uniform float opacity;

uniform vec3 shadeColorFactor;
#ifdef USE_SHADEMULTIPLYTEXTURE
  uniform sampler2D shadeMultiplyTexture;
  uniform mat3 shadeMultiplyTextureUvTransform;
#endif

uniform float shadingShiftFactor;
uniform float shadingToonyFactor;

#ifdef USE_SHADINGSHIFTTEXTURE
  uniform sampler2D shadingShiftTexture;
  uniform mat3 shadingShiftTextureUvTransform;
  uniform float shadingShiftTextureScale;
#endif

uniform float giEqualizationFactor;

uniform vec3 parametricRimColorFactor;
#ifdef USE_RIMMULTIPLYTEXTURE
  uniform sampler2D rimMultiplyTexture;
  uniform mat3 rimMultiplyTextureUvTransform;
#endif
uniform float rimLightingMixFactor;
uniform float parametricRimFresnelPowerFactor;
uniform float parametricRimLiftFactor;

#ifdef USE_MATCAPTEXTURE
  uniform vec3 matcapFactor;
  uniform sampler2D matcapTexture;
  uniform mat3 matcapTextureUvTransform;
#endif

uniform vec3 emissive;
uniform float emissiveIntensity;

uniform vec3 outlineColorFactor;
uniform float outlineLightingMixFactor;

#ifdef USE_UVANIMATIONMASKTEXTURE
  uniform sampler2D uvAnimationMaskTexture;
  uniform mat3 uvAnimationMaskTextureUvTransform;
#endif

uniform float uvAnimationScrollXOffset;
uniform float uvAnimationScrollYOffset;
uniform float uvAnimationRotationPhase;

#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>

// #include <uv_pars_fragment>
#if ( defined( MTOON_USE_UV ) && !defined( MTOON_UVS_VERTEX_ONLY ) )
  varying vec2 vUv;
#endif

// #include <uv2_pars_fragment>
// COMAPT: pre-r151 uses uv2 for lightMap and aoMap
#if THREE_VRM_THREE_REVISION < 151
  #if defined( USE_LIGHTMAP ) || defined( USE_AOMAP )
    varying vec2 vUv2;
  #endif
#endif

#include <map_pars_fragment>

#ifdef USE_MAP
  uniform mat3 mapUvTransform;
#endif

// #include <alphamap_pars_fragment>

#include <alphatest_pars_fragment>

#include <aomap_pars_fragment>
// #include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>

#ifdef USE_EMISSIVEMAP
  uniform mat3 emissiveMapUvTransform;
#endif

// #include <envmap_common_pars_fragment>
// #include <envmap_pars_fragment>
// #include <cube_uv_reflection_fragment>
#include <fog_pars_fragment>

// #include <bsdfs>
// COMPAT: pre-r151 doesn't have BRDF_Lambert in <common>
#if THREE_VRM_THREE_REVISION < 151
  vec3 BRDF_Lambert( const in vec3 diffuseColor ) {
    return RECIPROCAL_PI * diffuseColor;
  }
#endif

#include <lights_pars_begin>

#include <normal_pars_fragment>

// #include <lights_phong_pars_fragment>
varying vec3 vViewPosition;

struct MToonMaterial {
  vec3 diffuseColor;
  vec3 shadeColor;
  float shadingShift;
};

float linearstep( float a, float b, float t ) {
  return clamp( ( t - a ) / ( b - a ), 0.0, 1.0 );
}

/**
 * Convert NdotL into toon shading factor using shadingShift and shadingToony
 */
float getShading(
  const in float dotNL,
  const in float shadow,
  const in float shadingShift
) {
  float shading = dotNL;
  shading = shading + shadingShift;
  shading = linearstep( -1.0 + shadingToonyFactor, 1.0 - shadingToonyFactor, shading );
  shading *= shadow;
  return shading;
}

/**
 * Mix diffuseColor and shadeColor using shading factor and light color
 */
vec3 getDiffuse(
  const in MToonMaterial material,
  const in float shading,
  in vec3 lightColor
) {
  #ifdef DEBUG_LITSHADERATE
    return vec3( BRDF_Lambert( shading * lightColor ) );
  #endif

  vec3 col = lightColor * BRDF_Lambert( mix( material.shadeColor, material.diffuseColor, shading ) );

  // The "comment out if you want to PBR absolutely" line
  #ifdef V0_COMPAT_SHADE
    col = min( col, material.diffuseColor );
  #endif

  return col;
}

// COMPAT: pre-r156 uses a struct GeometricContext
#if THREE_VRM_THREE_REVISION >= 157
  void RE_Direct_MToon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in MToonMaterial material, const in float shadow, inout ReflectedLight reflectedLight ) {
    float dotNL = clamp( dot( geometryNormal, directLight.direction ), -1.0, 1.0 );
    vec3 irradiance = directLight.color;

    // directSpecular will be used for rim lighting, not an actual specular
    reflectedLight.directSpecular += irradiance;

    irradiance *= dotNL;

    float shading = getShading( dotNL, shadow, material.shadingShift );

    // toon shaded diffuse
    reflectedLight.directDiffuse += getDiffuse( material, shading, directLight.color );
  }

  void RE_IndirectDiffuse_MToon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in MToonMaterial material, inout ReflectedLight reflectedLight ) {
    // indirect diffuse will use diffuseColor, no shadeColor involved
    reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );

    // directSpecular will be used for rim lighting, not an actual specular
    reflectedLight.directSpecular += irradiance;
  }
#else
  void RE_Direct_MToon( const in IncidentLight directLight, const in GeometricContext geometry, const in MToonMaterial material, const in float shadow, inout ReflectedLight reflectedLight ) {
    float dotNL = clamp( dot( geometry.normal, directLight.direction ), -1.0, 1.0 );
    vec3 irradiance = directLight.color;

    // directSpecular will be used for rim lighting, not an actual specular
    reflectedLight.directSpecular += irradiance;

    irradiance *= dotNL;

    float shading = getShading( dotNL, shadow, material.shadingShift );

    // toon shaded diffuse
    reflectedLight.directDiffuse += getDiffuse( material, shading, directLight.color );
  }

  void RE_IndirectDiffuse_MToon( const in vec3 irradiance, const in GeometricContext geometry, const in MToonMaterial material, inout ReflectedLight reflectedLight ) {
    // indirect diffuse will use diffuseColor, no shadeColor involved
    reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );

    // directSpecular will be used for rim lighting, not an actual specular
    reflectedLight.directSpecular += irradiance;
  }
#endif

#define RE_Direct RE_Direct_MToon
#define RE_IndirectDiffuse RE_IndirectDiffuse_MToon
#define Material_LightProbeLOD( material ) (0)

#include <shadowmap_pars_fragment>
// #include <bumpmap_pars_fragment>

// #include <normalmap_pars_fragment>
#ifdef USE_NORMALMAP

  uniform sampler2D normalMap;
  uniform mat3 normalMapUvTransform;
  uniform vec2 normalScale;

#endif

// COMPAT: pre-r151
// USE_NORMALMAP_OBJECTSPACE used to be OBJECTSPACE_NORMALMAP in pre-r151
#if defined( USE_NORMALMAP_OBJECTSPACE ) || defined( OBJECTSPACE_NORMALMAP )

  uniform mat3 normalMatrix;

#endif

// COMPAT: pre-r151
// USE_NORMALMAP_TANGENTSPACE used to be TANGENTSPACE_NORMALMAP in pre-r151
#if ! defined ( USE_TANGENT ) && ( defined ( USE_NORMALMAP_TANGENTSPACE ) || defined ( TANGENTSPACE_NORMALMAP ) )

  // Per-Pixel Tangent Space Normal Mapping
  // http://hacksoflife.blogspot.ch/2009/11/per-pixel-tangent-space-normal-mapping.html

  // three-vrm specific change: it requires \`uv\` as an input in order to support uv scrolls

  // Temporary compat against shader change @ Three.js r126, r151
  #if THREE_VRM_THREE_REVISION >= 151

    mat3 getTangentFrame( vec3 eye_pos, vec3 surf_norm, vec2 uv ) {

      vec3 q0 = dFdx( eye_pos.xyz );
      vec3 q1 = dFdy( eye_pos.xyz );
      vec2 st0 = dFdx( uv.st );
      vec2 st1 = dFdy( uv.st );

      vec3 N = surf_norm;

      vec3 q1perp = cross( q1, N );
      vec3 q0perp = cross( N, q0 );

      vec3 T = q1perp * st0.x + q0perp * st1.x;
      vec3 B = q1perp * st0.y + q0perp * st1.y;

      float det = max( dot( T, T ), dot( B, B ) );
      float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );

      return mat3( T * scale, B * scale, N );

    }

  #else

    vec3 perturbNormal2Arb( vec2 uv, vec3 eye_pos, vec3 surf_norm, vec3 mapN, float faceDirection ) {

      vec3 q0 = vec3( dFdx( eye_pos.x ), dFdx( eye_pos.y ), dFdx( eye_pos.z ) );
      vec3 q1 = vec3( dFdy( eye_pos.x ), dFdy( eye_pos.y ), dFdy( eye_pos.z ) );
      vec2 st0 = dFdx( uv.st );
      vec2 st1 = dFdy( uv.st );

      vec3 N = normalize( surf_norm );

      vec3 q1perp = cross( q1, N );
      vec3 q0perp = cross( N, q0 );

      vec3 T = q1perp * st0.x + q0perp * st1.x;
      vec3 B = q1perp * st0.y + q0perp * st1.y;

      // three-vrm specific change: Workaround for the issue that happens when delta of uv = 0.0
      // TODO: Is this still required? Or shall I make a PR about it?
      if ( length( T ) == 0.0 || length( B ) == 0.0 ) {
        return surf_norm;
      }

      float det = max( dot( T, T ), dot( B, B ) );
      float scale = ( det == 0.0 ) ? 0.0 : faceDirection * inversesqrt( det );

      return normalize( T * ( mapN.x * scale ) + B * ( mapN.y * scale ) + N * mapN.z );

    }

  #endif

#endif

// #include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>

// == post correction ==========================================================
void postCorrection() {
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
  #include <premultiplied_alpha_fragment>
  #include <dithering_fragment>
}

// == main procedure ===========================================================
void main() {
  #include <clipping_planes_fragment>

  vec2 uv = vec2(0.5, 0.5);

  #if ( defined( MTOON_USE_UV ) && !defined( MTOON_UVS_VERTEX_ONLY ) )
    uv = vUv;

    float uvAnimMask = 1.0;
    #ifdef USE_UVANIMATIONMASKTEXTURE
      vec2 uvAnimationMaskTextureUv = ( uvAnimationMaskTextureUvTransform * vec3( uv, 1 ) ).xy;
      uvAnimMask = texture2D( uvAnimationMaskTexture, uvAnimationMaskTextureUv ).b;
    #endif

    float uvRotCos = cos( uvAnimationRotationPhase * uvAnimMask );
    float uvRotSin = sin( uvAnimationRotationPhase * uvAnimMask );
    uv = mat2( uvRotCos, -uvRotSin, uvRotSin, uvRotCos ) * ( uv - 0.5 ) + 0.5;
    uv = uv + vec2( uvAnimationScrollXOffset, uvAnimationScrollYOffset ) * uvAnimMask;
  #endif

  #ifdef DEBUG_UV
    gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
    #if ( defined( MTOON_USE_UV ) && !defined( MTOON_UVS_VERTEX_ONLY ) )
      gl_FragColor = vec4( uv, 0.0, 1.0 );
    #endif
    return;
  #endif

  vec4 diffuseColor = vec4( litFactor, opacity );
  ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
  vec3 totalEmissiveRadiance = emissive * emissiveIntensity;

  #include <logdepthbuf_fragment>

  // #include <map_fragment>
  #ifdef USE_MAP
    vec2 mapUv = ( mapUvTransform * vec3( uv, 1 ) ).xy;
    vec4 sampledDiffuseColor = texture2D( map, mapUv );
    #ifdef DECODE_VIDEO_TEXTURE
      sampledDiffuseColor = vec4( mix( pow( sampledDiffuseColor.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), sampledDiffuseColor.rgb * 0.0773993808, vec3( lessThanEqual( sampledDiffuseColor.rgb, vec3( 0.04045 ) ) ) ), sampledDiffuseColor.w );
    #endif
    diffuseColor *= sampledDiffuseColor;
  #endif

  // #include <color_fragment>
  #if ( defined( USE_COLOR ) && !defined( IGNORE_VERTEX_COLOR ) )
    diffuseColor.rgb *= vColor;
  #endif

  // #include <alphamap_fragment>

  #include <alphatest_fragment>

  // #include <specularmap_fragment>

  // #include <normal_fragment_begin>
  float faceDirection = gl_FrontFacing ? 1.0 : -1.0;

  #ifdef FLAT_SHADED

    vec3 fdx = dFdx( vViewPosition );
    vec3 fdy = dFdy( vViewPosition );
    vec3 normal = normalize( cross( fdx, fdy ) );

  #else

    vec3 normal = normalize( vNormal );

    #ifdef DOUBLE_SIDED

      normal *= faceDirection;

    #endif

  #endif

  #ifdef USE_NORMALMAP

    vec2 normalMapUv = ( normalMapUvTransform * vec3( uv, 1 ) ).xy;

  #endif

  #ifdef USE_NORMALMAP_TANGENTSPACE

    #ifdef USE_TANGENT

      mat3 tbn = mat3( normalize( vTangent ), normalize( vBitangent ), normal );

    #else

      mat3 tbn = getTangentFrame( - vViewPosition, normal, normalMapUv );

    #endif

    #if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )

      tbn[0] *= faceDirection;
      tbn[1] *= faceDirection;

    #endif

  #endif

  #ifdef USE_CLEARCOAT_NORMALMAP

    #ifdef USE_TANGENT

      mat3 tbn2 = mat3( normalize( vTangent ), normalize( vBitangent ), normal );

    #else

      mat3 tbn2 = getTangentFrame( - vViewPosition, normal, vClearcoatNormalMapUv );

    #endif

    #if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )

      tbn2[0] *= faceDirection;
      tbn2[1] *= faceDirection;

    #endif

  #endif

  // non perturbed normal for clearcoat among others

  vec3 nonPerturbedNormal = normal;

  #ifdef OUTLINE
    normal *= -1.0;
  #endif

  // #include <normal_fragment_maps>

  // COMPAT: pre-r151
  // USE_NORMALMAP_OBJECTSPACE used to be OBJECTSPACE_NORMALMAP in pre-r151
  #if defined( USE_NORMALMAP_OBJECTSPACE ) || defined( OBJECTSPACE_NORMALMAP )

    normal = texture2D( normalMap, normalMapUv ).xyz * 2.0 - 1.0; // overrides both flatShading and attribute normals

    #ifdef FLIP_SIDED

      normal = - normal;

    #endif

    #ifdef DOUBLE_SIDED

      normal = normal * faceDirection;

    #endif

    normal = normalize( normalMatrix * normal );

  // COMPAT: pre-r151
  // USE_NORMALMAP_TANGENTSPACE used to be TANGENTSPACE_NORMALMAP in pre-r151
  #elif defined( USE_NORMALMAP_TANGENTSPACE ) || defined( TANGENTSPACE_NORMALMAP )

    vec3 mapN = texture2D( normalMap, normalMapUv ).xyz * 2.0 - 1.0;
    mapN.xy *= normalScale;

    // COMPAT: pre-r151
    #if THREE_VRM_THREE_REVISION >= 151 || defined( USE_TANGENT )

      normal = normalize( tbn * mapN );

    #else

      normal = perturbNormal2Arb( uv, -vViewPosition, normal, mapN, faceDirection );

    #endif

  #endif

  // #include <emissivemap_fragment>
  #ifdef USE_EMISSIVEMAP
    vec2 emissiveMapUv = ( emissiveMapUvTransform * vec3( uv, 1 ) ).xy;
    totalEmissiveRadiance *= texture2D( emissiveMap, emissiveMapUv ).rgb;
  #endif

  #ifdef DEBUG_NORMAL
    gl_FragColor = vec4( 0.5 + 0.5 * normal, 1.0 );
    return;
  #endif

  // -- MToon: lighting --------------------------------------------------------
  // accumulation
  // #include <lights_phong_fragment>
  MToonMaterial material;

  material.diffuseColor = diffuseColor.rgb;

  material.shadeColor = shadeColorFactor;
  #ifdef USE_SHADEMULTIPLYTEXTURE
    vec2 shadeMultiplyTextureUv = ( shadeMultiplyTextureUvTransform * vec3( uv, 1 ) ).xy;
    material.shadeColor *= texture2D( shadeMultiplyTexture, shadeMultiplyTextureUv ).rgb;
  #endif

  #if ( defined( USE_COLOR ) && !defined( IGNORE_VERTEX_COLOR ) )
    material.shadeColor.rgb *= vColor;
  #endif

  material.shadingShift = shadingShiftFactor;
  #ifdef USE_SHADINGSHIFTTEXTURE
    vec2 shadingShiftTextureUv = ( shadingShiftTextureUvTransform * vec3( uv, 1 ) ).xy;
    material.shadingShift += texture2D( shadingShiftTexture, shadingShiftTextureUv ).r * shadingShiftTextureScale;
  #endif

  // #include <lights_fragment_begin>

  // MToon Specific changes:
  // Since we want to take shadows into account of shading instead of irradiance,
  // we had to modify the codes that multiplies the results of shadowmap into color of direct lights.

  // COMPAT: pre-r156 uses a struct GeometricContext
  #if THREE_VRM_THREE_REVISION >= 157
    vec3 geometryPosition = - vViewPosition;
    vec3 geometryNormal = normal;
    vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );

    vec3 geometryClearcoatNormal;

    #ifdef USE_CLEARCOAT

      geometryClearcoatNormal = clearcoatNormal;

    #endif
  #else
    GeometricContext geometry;

    geometry.position = - vViewPosition;
    geometry.normal = normal;
    geometry.viewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );

    #ifdef USE_CLEARCOAT

      geometry.clearcoatNormal = clearcoatNormal;

    #endif
  #endif

  IncidentLight directLight;

  // since these variables will be used in unrolled loop, we have to define in prior
  float shadow;

  #if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )

    PointLight pointLight;
    #if defined( USE_SHADOWMAP ) && NUM_POINT_LIGHT_SHADOWS > 0
    PointLightShadow pointLightShadow;
    #endif

    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {

      pointLight = pointLights[ i ];

      // COMPAT: pre-r156 uses a struct GeometricContext
      #if THREE_VRM_THREE_REVISION >= 157
        getPointLightInfo( pointLight, geometryPosition, directLight );
      #else
        getPointLightInfo( pointLight, geometry, directLight );
      #endif

      shadow = 1.0;
      #if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_POINT_LIGHT_SHADOWS )
      pointLightShadow = pointLightShadows[ i ];
      // COMPAT: pre-r166
      // r166 introduced shadowIntensity
      #if THREE_VRM_THREE_REVISION >= 166
        shadow = all( bvec2( directLight.visible, receiveShadow ) ) ? getPointShadow( pointShadowMap[ i ], pointLightShadow.shadowMapSize, pointLightShadow.shadowIntensity, pointLightShadow.shadowBias, pointLightShadow.shadowRadius, vPointShadowCoord[ i ], pointLightShadow.shadowCameraNear, pointLightShadow.shadowCameraFar ) : 1.0;
      #else
        shadow = all( bvec2( directLight.visible, receiveShadow ) ) ? getPointShadow( pointShadowMap[ i ], pointLightShadow.shadowMapSize, pointLightShadow.shadowBias, pointLightShadow.shadowRadius, vPointShadowCoord[ i ], pointLightShadow.shadowCameraNear, pointLightShadow.shadowCameraFar ) : 1.0;
      #endif
      #endif

      // COMPAT: pre-r156 uses a struct GeometricContext
      #if THREE_VRM_THREE_REVISION >= 157
        RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, shadow, reflectedLight );
      #else
        RE_Direct( directLight, geometry, material, shadow, reflectedLight );
      #endif

    }
    #pragma unroll_loop_end

  #endif

  #if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )

    SpotLight spotLight;
    // COMPAT: pre-r144 uses NUM_SPOT_LIGHT_SHADOWS, r144+ uses NUM_SPOT_LIGHT_COORDS
    #if THREE_VRM_THREE_REVISION >= 144
      #if defined( USE_SHADOWMAP ) && NUM_SPOT_LIGHT_COORDS > 0
      SpotLightShadow spotLightShadow;
      #endif
    #elif defined( USE_SHADOWMAP ) && NUM_SPOT_LIGHT_SHADOWS > 0
    SpotLightShadow spotLightShadow;
    #endif

    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {

      spotLight = spotLights[ i ];

      // COMPAT: pre-r156 uses a struct GeometricContext
      #if THREE_VRM_THREE_REVISION >= 157
        getSpotLightInfo( spotLight, geometryPosition, directLight );
      #else
        getSpotLightInfo( spotLight, geometry, directLight );
      #endif

      shadow = 1.0;
      // COMPAT: pre-r144 uses NUM_SPOT_LIGHT_SHADOWS and vSpotShadowCoord, r144+ uses NUM_SPOT_LIGHT_COORDS and vSpotLightCoord
      // COMPAT: pre-r166 does not have shadowIntensity, r166+ has shadowIntensity
      #if THREE_VRM_THREE_REVISION >= 166
        #if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_COORDS )
        spotLightShadow = spotLightShadows[ i ];
        shadow = all( bvec2( directLight.visible, receiveShadow ) ) ? getShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowIntensity, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
        #endif
      #elif THREE_VRM_THREE_REVISION >= 144
        #if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_COORDS )
        spotLightShadow = spotLightShadows[ i ];
        shadow = all( bvec2( directLight.visible, receiveShadow ) ) ? getShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
        #endif
      #elif defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
      spotLightShadow = spotLightShadows[ i ];
      shadow = all( bvec2( directLight.visible, receiveShadow ) ) ? getShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotShadowCoord[ i ] ) : 1.0;
      #endif

      // COMPAT: pre-r156 uses a struct GeometricContext
      #if THREE_VRM_THREE_REVISION >= 157
        RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, shadow, reflectedLight );
      #else
        RE_Direct( directLight, geometry, material, shadow, reflectedLight );
      #endif

    }
    #pragma unroll_loop_end

  #endif

  #if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )

    DirectionalLight directionalLight;
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    DirectionalLightShadow directionalLightShadow;
    #endif

    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {

      directionalLight = directionalLights[ i ];

      // COMPAT: pre-r156 uses a struct GeometricContext
      #if THREE_VRM_THREE_REVISION >= 157
        getDirectionalLightInfo( directionalLight, directLight );
      #else
        getDirectionalLightInfo( directionalLight, geometry, directLight );
      #endif

      shadow = 1.0;
      #if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
      directionalLightShadow = directionalLightShadows[ i ];
      // COMPAT: pre-r166
      // r166 introduced shadowIntensity
      #if THREE_VRM_THREE_REVISION >= 166
        shadow = all( bvec2( directLight.visible, receiveShadow ) ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
      #else
        shadow = all( bvec2( directLight.visible, receiveShadow ) ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
      #endif
      #endif

      // COMPAT: pre-r156 uses a struct GeometricContext
      #if THREE_VRM_THREE_REVISION >= 157
        RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, shadow, reflectedLight );
      #else
        RE_Direct( directLight, geometry, material, shadow, reflectedLight );
      #endif

    }
    #pragma unroll_loop_end

  #endif

  // #if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )

  //   RectAreaLight rectAreaLight;

  //   #pragma unroll_loop_start
  //   for ( int i = 0; i < NUM_RECT_AREA_LIGHTS; i ++ ) {

  //     rectAreaLight = rectAreaLights[ i ];
  //     RE_Direct_RectArea( rectAreaLight, geometry, material, reflectedLight );

  //   }
  //   #pragma unroll_loop_end

  // #endif

  #if defined( RE_IndirectDiffuse )

    vec3 iblIrradiance = vec3( 0.0 );

    vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );

    // COMPAT: pre-r156 uses a struct GeometricContext
    // COMPAT: pre-r156 doesn't have a define USE_LIGHT_PROBES
    #if THREE_VRM_THREE_REVISION >= 157
      #if defined( USE_LIGHT_PROBES )
        irradiance += getLightProbeIrradiance( lightProbe, geometryNormal );
      #endif
    #else
      irradiance += getLightProbeIrradiance( lightProbe, geometry.normal );
    #endif

    #if ( NUM_HEMI_LIGHTS > 0 )

      #pragma unroll_loop_start
      for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {

        // COMPAT: pre-r156 uses a struct GeometricContext
        #if THREE_VRM_THREE_REVISION >= 157
          irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );
        #else
          irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometry.normal );
        #endif

      }
      #pragma unroll_loop_end

    #endif

  #endif

  // #if defined( RE_IndirectSpecular )

  //   vec3 radiance = vec3( 0.0 );
  //   vec3 clearcoatRadiance = vec3( 0.0 );

  // #endif

  #include <lights_fragment_maps>
  #include <lights_fragment_end>

  // modulation
  #include <aomap_fragment>

  vec3 col = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;

  #ifdef DEBUG_LITSHADERATE
    gl_FragColor = vec4( col, diffuseColor.a );
    postCorrection();
    return;
  #endif

  // -- MToon: rim lighting -----------------------------------------
  vec3 viewDir = normalize( vViewPosition );

  #ifndef PHYSICALLY_CORRECT_LIGHTS
    reflectedLight.directSpecular /= PI;
  #endif
  vec3 rimMix = mix( vec3( 1.0 ), reflectedLight.directSpecular, rimLightingMixFactor );

  vec3 rim = parametricRimColorFactor * pow( saturate( 1.0 - dot( viewDir, normal ) + parametricRimLiftFactor ), parametricRimFresnelPowerFactor );

  #ifdef USE_MATCAPTEXTURE
    {
      vec3 x = normalize( vec3( viewDir.z, 0.0, -viewDir.x ) );
      vec3 y = cross( viewDir, x ); // guaranteed to be normalized
      vec2 sphereUv = 0.5 + 0.5 * vec2( dot( x, normal ), -dot( y, normal ) );
      sphereUv = ( matcapTextureUvTransform * vec3( sphereUv, 1 ) ).xy;
      vec3 matcap = texture2D( matcapTexture, sphereUv ).rgb;
      rim += matcapFactor * matcap;
    }
  #endif

  #ifdef USE_RIMMULTIPLYTEXTURE
    vec2 rimMultiplyTextureUv = ( rimMultiplyTextureUvTransform * vec3( uv, 1 ) ).xy;
    rim *= texture2D( rimMultiplyTexture, rimMultiplyTextureUv ).rgb;
  #endif

  col += rimMix * rim;

  // -- MToon: Emission --------------------------------------------------------
  col += totalEmissiveRadiance;

  // #include <envmap_fragment>

  // -- Almost done! -----------------------------------------------------------
  #if defined( OUTLINE )
    col = outlineColorFactor.rgb * mix( vec3( 1.0 ), col, outlineLightingMixFactor );
  #endif

  #ifdef OPAQUE
    diffuseColor.a = 1.0;
  #endif

  gl_FragColor = vec4( col, diffuseColor.a );
  postCorrection();
}
`,Ri={None:"none",Normal:"normal",LitShadeRate:"litShadeRate",UV:"uv"},Mt={None:"none",WorldCoordinates:"worldCoordinates",ScreenCoordinates:"screenCoordinates"},Eo={3e3:"",3001:"srgb"};function it(e){return parseInt(Q,10)>=152?e.colorSpace:Eo[e.encoding]}var Ti=class extends Mr{constructor(e={}){var t;super({vertexShader:Ao,fragmentShader:Po}),this.uvAnimationScrollXSpeedFactor=0,this.uvAnimationScrollYSpeedFactor=0,this.uvAnimationRotationSpeedFactor=0,this.fog=!0,this.normalMapType=xr,this._ignoreVertexColor=!0,this._v0CompatShade=!1,this._debugMode=Ri.None,this._outlineWidthMode=Mt.None,this._isOutline=!1,e.transparentWithZWrite&&(e.depthWrite=!0),delete e.transparentWithZWrite,e.fog=!0,e.lights=!0,e.clipping=!0,this.uniforms=yr.merge([_e.common,_e.normalmap,_e.emissivemap,_e.fog,_e.lights,{litFactor:{value:new O(1,1,1)},mapUvTransform:{value:new W},colorAlpha:{value:1},normalMapUvTransform:{value:new W},shadeColorFactor:{value:new O(0,0,0)},shadeMultiplyTexture:{value:null},shadeMultiplyTextureUvTransform:{value:new W},shadingShiftFactor:{value:0},shadingShiftTexture:{value:null},shadingShiftTextureUvTransform:{value:new W},shadingShiftTextureScale:{value:1},shadingToonyFactor:{value:.9},giEqualizationFactor:{value:.9},matcapFactor:{value:new O(1,1,1)},matcapTexture:{value:null},matcapTextureUvTransform:{value:new W},parametricRimColorFactor:{value:new O(0,0,0)},rimMultiplyTexture:{value:null},rimMultiplyTextureUvTransform:{value:new W},rimLightingMixFactor:{value:1},parametricRimFresnelPowerFactor:{value:5},parametricRimLiftFactor:{value:0},emissive:{value:new O(0,0,0)},emissiveIntensity:{value:1},emissiveMapUvTransform:{value:new W},outlineWidthMultiplyTexture:{value:null},outlineWidthMultiplyTextureUvTransform:{value:new W},outlineWidthFactor:{value:0},outlineColorFactor:{value:new O(0,0,0)},outlineLightingMixFactor:{value:1},uvAnimationMaskTexture:{value:null},uvAnimationMaskTextureUvTransform:{value:new W},uvAnimationScrollXOffset:{value:0},uvAnimationScrollYOffset:{value:0},uvAnimationRotationPhase:{value:0}},(t=e.uniforms)!=null?t:{}]),this.setValues(e),this._uploadUniformsWorkaround(),this.customProgramCacheKey=()=>[...Object.entries(this._generateDefines()).map(([n,i])=>`${n}:${i}`),this.matcapTexture?`matcapTextureColorSpace:${it(this.matcapTexture)}`:"",this.shadeMultiplyTexture?`shadeMultiplyTextureColorSpace:${it(this.shadeMultiplyTexture)}`:"",this.rimMultiplyTexture?`rimMultiplyTextureColorSpace:${it(this.rimMultiplyTexture)}`:""].join(","),this.onBeforeCompile=n=>{const i=parseInt(Q,10),r=Object.entries(Hn(Hn({},this._generateDefines()),this.defines)).filter(([o,s])=>!!s).map(([o,s])=>`#define ${o} ${s}`).join(`
`)+`
`;n.vertexShader=r+n.vertexShader,n.fragmentShader=r+n.fragmentShader,i<154&&(n.fragmentShader=n.fragmentShader.replace("#include <colorspace_fragment>","#include <encodings_fragment>"))}}get color(){return this.uniforms.litFactor.value}set color(e){this.uniforms.litFactor.value=e}get map(){return this.uniforms.map.value}set map(e){this.uniforms.map.value=e}get normalMap(){return this.uniforms.normalMap.value}set normalMap(e){this.uniforms.normalMap.value=e}get normalScale(){return this.uniforms.normalScale.value}set normalScale(e){this.uniforms.normalScale.value=e}get emissive(){return this.uniforms.emissive.value}set emissive(e){this.uniforms.emissive.value=e}get emissiveIntensity(){return this.uniforms.emissiveIntensity.value}set emissiveIntensity(e){this.uniforms.emissiveIntensity.value=e}get emissiveMap(){return this.uniforms.emissiveMap.value}set emissiveMap(e){this.uniforms.emissiveMap.value=e}get shadeColorFactor(){return this.uniforms.shadeColorFactor.value}set shadeColorFactor(e){this.uniforms.shadeColorFactor.value=e}get shadeMultiplyTexture(){return this.uniforms.shadeMultiplyTexture.value}set shadeMultiplyTexture(e){this.uniforms.shadeMultiplyTexture.value=e}get shadingShiftFactor(){return this.uniforms.shadingShiftFactor.value}set shadingShiftFactor(e){this.uniforms.shadingShiftFactor.value=e}get shadingShiftTexture(){return this.uniforms.shadingShiftTexture.value}set shadingShiftTexture(e){this.uniforms.shadingShiftTexture.value=e}get shadingShiftTextureScale(){return this.uniforms.shadingShiftTextureScale.value}set shadingShiftTextureScale(e){this.uniforms.shadingShiftTextureScale.value=e}get shadingToonyFactor(){return this.uniforms.shadingToonyFactor.value}set shadingToonyFactor(e){this.uniforms.shadingToonyFactor.value=e}get giEqualizationFactor(){return this.uniforms.giEqualizationFactor.value}set giEqualizationFactor(e){this.uniforms.giEqualizationFactor.value=e}get matcapFactor(){return this.uniforms.matcapFactor.value}set matcapFactor(e){this.uniforms.matcapFactor.value=e}get matcapTexture(){return this.uniforms.matcapTexture.value}set matcapTexture(e){this.uniforms.matcapTexture.value=e}get parametricRimColorFactor(){return this.uniforms.parametricRimColorFactor.value}set parametricRimColorFactor(e){this.uniforms.parametricRimColorFactor.value=e}get rimMultiplyTexture(){return this.uniforms.rimMultiplyTexture.value}set rimMultiplyTexture(e){this.uniforms.rimMultiplyTexture.value=e}get rimLightingMixFactor(){return this.uniforms.rimLightingMixFactor.value}set rimLightingMixFactor(e){this.uniforms.rimLightingMixFactor.value=e}get parametricRimFresnelPowerFactor(){return this.uniforms.parametricRimFresnelPowerFactor.value}set parametricRimFresnelPowerFactor(e){this.uniforms.parametricRimFresnelPowerFactor.value=e}get parametricRimLiftFactor(){return this.uniforms.parametricRimLiftFactor.value}set parametricRimLiftFactor(e){this.uniforms.parametricRimLiftFactor.value=e}get outlineWidthMultiplyTexture(){return this.uniforms.outlineWidthMultiplyTexture.value}set outlineWidthMultiplyTexture(e){this.uniforms.outlineWidthMultiplyTexture.value=e}get outlineWidthFactor(){return this.uniforms.outlineWidthFactor.value}set outlineWidthFactor(e){this.uniforms.outlineWidthFactor.value=e}get outlineColorFactor(){return this.uniforms.outlineColorFactor.value}set outlineColorFactor(e){this.uniforms.outlineColorFactor.value=e}get outlineLightingMixFactor(){return this.uniforms.outlineLightingMixFactor.value}set outlineLightingMixFactor(e){this.uniforms.outlineLightingMixFactor.value=e}get uvAnimationMaskTexture(){return this.uniforms.uvAnimationMaskTexture.value}set uvAnimationMaskTexture(e){this.uniforms.uvAnimationMaskTexture.value=e}get uvAnimationScrollXOffset(){return this.uniforms.uvAnimationScrollXOffset.value}set uvAnimationScrollXOffset(e){this.uniforms.uvAnimationScrollXOffset.value=e}get uvAnimationScrollYOffset(){return this.uniforms.uvAnimationScrollYOffset.value}set uvAnimationScrollYOffset(e){this.uniforms.uvAnimationScrollYOffset.value=e}get uvAnimationRotationPhase(){return this.uniforms.uvAnimationRotationPhase.value}set uvAnimationRotationPhase(e){this.uniforms.uvAnimationRotationPhase.value=e}get ignoreVertexColor(){return this._ignoreVertexColor}set ignoreVertexColor(e){this._ignoreVertexColor=e,this.needsUpdate=!0}get v0CompatShade(){return this._v0CompatShade}set v0CompatShade(e){this._v0CompatShade=e,this.needsUpdate=!0}get debugMode(){return this._debugMode}set debugMode(e){this._debugMode=e,this.needsUpdate=!0}get outlineWidthMode(){return this._outlineWidthMode}set outlineWidthMode(e){this._outlineWidthMode=e,this.needsUpdate=!0}get isOutline(){return this._isOutline}set isOutline(e){this._isOutline=e,this.needsUpdate=!0}get isMToonMaterial(){return!0}update(e){this._uploadUniformsWorkaround(),this._updateUVAnimation(e)}copy(e){return super.copy(e),this.map=e.map,this.normalMap=e.normalMap,this.emissiveMap=e.emissiveMap,this.shadeMultiplyTexture=e.shadeMultiplyTexture,this.shadingShiftTexture=e.shadingShiftTexture,this.matcapTexture=e.matcapTexture,this.rimMultiplyTexture=e.rimMultiplyTexture,this.outlineWidthMultiplyTexture=e.outlineWidthMultiplyTexture,this.uvAnimationMaskTexture=e.uvAnimationMaskTexture,this.normalMapType=e.normalMapType,this.uvAnimationScrollXSpeedFactor=e.uvAnimationScrollXSpeedFactor,this.uvAnimationScrollYSpeedFactor=e.uvAnimationScrollYSpeedFactor,this.uvAnimationRotationSpeedFactor=e.uvAnimationRotationSpeedFactor,this.ignoreVertexColor=e.ignoreVertexColor,this.v0CompatShade=e.v0CompatShade,this.debugMode=e.debugMode,this.outlineWidthMode=e.outlineWidthMode,this.isOutline=e.isOutline,this.needsUpdate=!0,this}_updateUVAnimation(e){this.uniforms.uvAnimationScrollXOffset.value+=e*this.uvAnimationScrollXSpeedFactor,this.uniforms.uvAnimationScrollYOffset.value+=e*this.uvAnimationScrollYSpeedFactor,this.uniforms.uvAnimationRotationPhase.value+=e*this.uvAnimationRotationSpeedFactor,this.uniforms.alphaTest.value=this.alphaTest,this.uniformsNeedUpdate=!0}_uploadUniformsWorkaround(){this.uniforms.opacity.value=this.opacity,this._updateTextureMatrix(this.uniforms.map,this.uniforms.mapUvTransform),this._updateTextureMatrix(this.uniforms.normalMap,this.uniforms.normalMapUvTransform),this._updateTextureMatrix(this.uniforms.emissiveMap,this.uniforms.emissiveMapUvTransform),this._updateTextureMatrix(this.uniforms.shadeMultiplyTexture,this.uniforms.shadeMultiplyTextureUvTransform),this._updateTextureMatrix(this.uniforms.shadingShiftTexture,this.uniforms.shadingShiftTextureUvTransform),this._updateTextureMatrix(this.uniforms.matcapTexture,this.uniforms.matcapTextureUvTransform),this._updateTextureMatrix(this.uniforms.rimMultiplyTexture,this.uniforms.rimMultiplyTextureUvTransform),this._updateTextureMatrix(this.uniforms.outlineWidthMultiplyTexture,this.uniforms.outlineWidthMultiplyTextureUvTransform),this._updateTextureMatrix(this.uniforms.uvAnimationMaskTexture,this.uniforms.uvAnimationMaskTextureUvTransform),this.uniformsNeedUpdate=!0}_generateDefines(){const e=parseInt(Q,10),t=this.outlineWidthMultiplyTexture!==null,n=this.map!==null||this.normalMap!==null||this.emissiveMap!==null||this.shadeMultiplyTexture!==null||this.shadingShiftTexture!==null||this.rimMultiplyTexture!==null||this.uvAnimationMaskTexture!==null;return{THREE_VRM_THREE_REVISION:e,OUTLINE:this._isOutline,MTOON_USE_UV:t||n,MTOON_UVS_VERTEX_ONLY:t&&!n,V0_COMPAT_SHADE:this._v0CompatShade,USE_SHADEMULTIPLYTEXTURE:this.shadeMultiplyTexture!==null,USE_SHADINGSHIFTTEXTURE:this.shadingShiftTexture!==null,USE_MATCAPTEXTURE:this.matcapTexture!==null,USE_RIMMULTIPLYTEXTURE:this.rimMultiplyTexture!==null,USE_OUTLINEWIDTHMULTIPLYTEXTURE:this._isOutline&&this.outlineWidthMultiplyTexture!==null,USE_UVANIMATIONMASKTEXTURE:this.uvAnimationMaskTexture!==null,IGNORE_VERTEX_COLOR:this._ignoreVertexColor===!0,DEBUG_NORMAL:this._debugMode==="normal",DEBUG_LITSHADERATE:this._debugMode==="litShadeRate",DEBUG_UV:this._debugMode==="uv",OUTLINE_WIDTH_SCREEN:this._isOutline&&this._outlineWidthMode===Mt.ScreenCoordinates}}_updateTextureMatrix(e,t){e.value&&(e.value.matrixAutoUpdate&&e.value.updateMatrix(),t.value.copy(e.value.matrix))}},Lo=new Set(["1.0","1.0-beta"]),wi=class Ue{get name(){return Ue.EXTENSION_NAME}constructor(t,n={}){var i,r,o,s;this.parser=t,this.materialType=(i=n.materialType)!=null?i:Ti,this.renderOrderOffset=(r=n.renderOrderOffset)!=null?r:0,this.v0CompatShade=(o=n.v0CompatShade)!=null?o:!1,this.debugMode=(s=n.debugMode)!=null?s:"none",this._mToonMaterialSet=new Set}beforeRoot(){return te(this,null,function*(){this._removeUnlitExtensionIfMToonExists()})}afterRoot(t){return te(this,null,function*(){t.userData.vrmMToonMaterials=Array.from(this._mToonMaterialSet)})}getMaterialType(t){return this._getMToonExtension(t)?this.materialType:null}extendMaterialParams(t,n){const i=this._getMToonExtension(t);return i?this._extendMaterialParams(i,n):null}loadMesh(t){return te(this,null,function*(){var n;const i=this.parser,o=(n=i.json.meshes)==null?void 0:n[t];if(o==null)throw new Error(`MToonMaterialLoaderPlugin: Attempt to use meshes[${t}] of glTF but the mesh doesn't exist`);const s=o.primitives,l=yield i.loadMesh(t);if(s.length===1){const a=l,u=s[0].material;u!=null&&this._setupPrimitive(a,u)}else{const a=l;for(let u=0;u<s.length;u++){const d=a.children[u],h=s[u].material;h!=null&&this._setupPrimitive(d,h)}}return l})}_removeUnlitExtensionIfMToonExists(){const i=this.parser.json.materials;i?.map((r,o)=>{var s;this._getMToonExtension(o)&&((s=r.extensions)!=null&&s.KHR_materials_unlit)&&delete r.extensions.KHR_materials_unlit})}_getMToonExtension(t){var n,i;const s=(n=this.parser.json.materials)==null?void 0:n[t];if(s==null){console.warn(`MToonMaterialLoaderPlugin: Attempt to use materials[${t}] of glTF but the material doesn't exist`);return}const l=(i=s.extensions)==null?void 0:i[Ue.EXTENSION_NAME];if(l==null)return;const a=l.specVersion;if(!Lo.has(a)){console.warn(`MToonMaterialLoaderPlugin: Unknown ${Ue.EXTENSION_NAME} specVersion "${a}"`);return}return l}_extendMaterialParams(t,n){return te(this,null,function*(){var i;delete n.metalness,delete n.roughness;const r=new So(this.parser,n);r.assignPrimitive("transparentWithZWrite",t.transparentWithZWrite),r.assignColor("shadeColorFactor",t.shadeColorFactor),r.assignTexture("shadeMultiplyTexture",t.shadeMultiplyTexture,!0),r.assignPrimitive("shadingShiftFactor",t.shadingShiftFactor),r.assignTexture("shadingShiftTexture",t.shadingShiftTexture,!0),r.assignPrimitive("shadingShiftTextureScale",(i=t.shadingShiftTexture)==null?void 0:i.scale),r.assignPrimitive("shadingToonyFactor",t.shadingToonyFactor),r.assignPrimitive("giEqualizationFactor",t.giEqualizationFactor),r.assignColor("matcapFactor",t.matcapFactor),r.assignTexture("matcapTexture",t.matcapTexture,!0),r.assignColor("parametricRimColorFactor",t.parametricRimColorFactor),r.assignTexture("rimMultiplyTexture",t.rimMultiplyTexture,!0),r.assignPrimitive("rimLightingMixFactor",t.rimLightingMixFactor),r.assignPrimitive("parametricRimFresnelPowerFactor",t.parametricRimFresnelPowerFactor),r.assignPrimitive("parametricRimLiftFactor",t.parametricRimLiftFactor),r.assignPrimitive("outlineWidthMode",t.outlineWidthMode),r.assignPrimitive("outlineWidthFactor",t.outlineWidthFactor),r.assignTexture("outlineWidthMultiplyTexture",t.outlineWidthMultiplyTexture,!1),r.assignColor("outlineColorFactor",t.outlineColorFactor),r.assignPrimitive("outlineLightingMixFactor",t.outlineLightingMixFactor),r.assignTexture("uvAnimationMaskTexture",t.uvAnimationMaskTexture,!1),r.assignPrimitive("uvAnimationScrollXSpeedFactor",t.uvAnimationScrollXSpeedFactor),r.assignPrimitive("uvAnimationScrollYSpeedFactor",t.uvAnimationScrollYSpeedFactor),r.assignPrimitive("uvAnimationRotationSpeedFactor",t.uvAnimationRotationSpeedFactor),r.assignPrimitive("v0CompatShade",this.v0CompatShade),r.assignPrimitive("debugMode",this.debugMode),yield r.pending})}_setupPrimitive(t,n){const i=this._getMToonExtension(n);if(i){const r=this._parseRenderOrder(i);t.renderOrder=r+this.renderOrderOffset,this._generateOutline(t),this._addToMaterialSet(t);return}}_shouldGenerateOutline(t){return typeof t.outlineWidthMode=="string"&&t.outlineWidthMode!=="none"&&typeof t.outlineWidthFactor=="number"&&t.outlineWidthFactor>0}_generateOutline(t){const n=t.material;if(!(n instanceof Rr)||!this._shouldGenerateOutline(n))return;t.material=[n];const i=n.clone();i.name+=" (Outline)",i.isOutline=!0,i.side=Tr,t.material.push(i);const r=t.geometry,o=r.index?r.index.count:r.attributes.position.count/3;r.addGroup(0,o,0),r.addGroup(0,o,1)}_addToMaterialSet(t){const n=t.material,i=new Set;Array.isArray(n)?n.forEach(r=>i.add(r)):i.add(n);for(const r of i)this._mToonMaterialSet.add(r)}_parseRenderOrder(t){var n;return(t.transparentWithZWrite?0:19)+((n=t.renderQueueOffsetNumber)!=null?n:0)}};wi.EXTENSION_NAME="VRMC_materials_mtoon";var Si=wi,bo=(e,t,n)=>new Promise((i,r)=>{var o=a=>{try{l(n.next(a))}catch(u){r(u)}},s=a=>{try{l(n.throw(a))}catch(u){r(u)}},l=a=>a.done?i(a.value):Promise.resolve(a.value).then(o,s);l((n=n.apply(e,t)).next())}),Ai=class xt{get name(){return xt.EXTENSION_NAME}constructor(t){this.parser=t}extendMaterialParams(t,n){return bo(this,null,function*(){const i=this._getHDREmissiveMultiplierExtension(t);if(i==null)return;console.warn("VRMMaterialsHDREmissiveMultiplierLoaderPlugin: `VRMC_materials_hdr_emissiveMultiplier` is archived. Use `KHR_materials_emissive_strength` instead.");const r=i.emissiveMultiplier;n.emissiveIntensity=r})}_getHDREmissiveMultiplierExtension(t){var n,i;const s=(n=this.parser.json.materials)==null?void 0:n[t];if(s==null){console.warn(`VRMMaterialsHDREmissiveMultiplierLoaderPlugin: Attempt to use materials[${t}] of glTF but the material doesn't exist`);return}const l=(i=s.extensions)==null?void 0:i[xt.EXTENSION_NAME];if(l!=null)return l}};Ai.EXTENSION_NAME="VRMC_materials_hdr_emissiveMultiplier";var Io=Ai,No=Object.defineProperty,Co=Object.defineProperties,Oo=Object.getOwnPropertyDescriptors,kn=Object.getOwnPropertySymbols,Uo=Object.prototype.hasOwnProperty,Vo=Object.prototype.propertyIsEnumerable,Wn=(e,t,n)=>t in e?No(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n,H=(e,t)=>{for(var n in t||(t={}))Uo.call(t,n)&&Wn(e,n,t[n]);if(kn)for(var n of kn(t))Vo.call(t,n)&&Wn(e,n,t[n]);return e},zn=(e,t)=>Co(e,Oo(t)),Fo=(e,t,n)=>new Promise((i,r)=>{var o=a=>{try{l(n.next(a))}catch(u){r(u)}},s=a=>{try{l(n.throw(a))}catch(u){r(u)}},l=a=>a.done?i(a.value):Promise.resolve(a.value).then(o,s);l((n=n.apply(e,t)).next())});function ae(e){return Math.pow(e,2.2)}var Do=class{get name(){return"VRMMaterialsV0CompatPlugin"}constructor(e){var t;this.parser=e,this._renderQueueMapTransparent=new Map,this._renderQueueMapTransparentZWrite=new Map;const n=this.parser.json;n.extensionsUsed=(t=n.extensionsUsed)!=null?t:[],n.extensionsUsed.indexOf("KHR_texture_transform")===-1&&n.extensionsUsed.push("KHR_texture_transform")}beforeRoot(){return Fo(this,null,function*(){var e;const t=this.parser.json,n=(e=t.extensions)==null?void 0:e.VRM,i=n?.materialProperties;i&&(this._populateRenderQueueMap(i),i.forEach((r,o)=>{var s,l;const a=(s=t.materials)==null?void 0:s[o];if(a==null){console.warn(`VRMMaterialsV0CompatPlugin: Attempt to use materials[${o}] of glTF but the material doesn't exist`);return}if(r.shader==="VRM/MToon"){const u=this._parseV0MToonProperties(r,a);t.materials[o]=u}else if((l=r.shader)!=null&&l.startsWith("VRM/Unlit")){const u=this._parseV0UnlitProperties(r,a);t.materials[o]=u}else r.shader==="VRM_USE_GLTFSHADER"||console.warn(`VRMMaterialsV0CompatPlugin: Unknown shader: ${r.shader}`)}))})}_parseV0MToonProperties(e,t){var n,i,r,o,s,l,a,u,d,h,c,p,f,m,g,v,y,R,T,M,x,w,P,I,E,b,C,G,me,fe,z,D,oe,ge,V,kt,Wt,zt,Xt,jt,Yt,Gt,qt,Qt,$t,Zt,Jt,Kt,en,tn,nn,rn,on,sn,an;const ln=(i=(n=e.keywordMap)==null?void 0:n._ALPHABLEND_ON)!=null?i:!1,zi=((r=e.floatProperties)==null?void 0:r._ZWrite)===1&&ln,Xi=this._v0ParseRenderQueue(e),un=(s=(o=e.keywordMap)==null?void 0:o._ALPHATEST_ON)!=null?s:!1,ji=ln?"BLEND":un?"MASK":"OPAQUE",Yi=un?(a=(l=e.floatProperties)==null?void 0:l._Cutoff)!=null?a:.5:void 0,Gi=((d=(u=e.floatProperties)==null?void 0:u._CullMode)!=null?d:2)===0,$=this._portTextureTransform(e),qi=((c=(h=e.vectorProperties)==null?void 0:h._Color)!=null?c:[1,1,1,1]).map((vn,vr)=>vr===3?vn:ae(vn)),dn=(p=e.textureProperties)==null?void 0:p._MainTex,Qi=dn!=null?{index:dn,extensions:H({},$)}:void 0,$i=(m=(f=e.floatProperties)==null?void 0:f._BumpScale)!=null?m:1,hn=(g=e.textureProperties)==null?void 0:g._BumpMap,Zi=hn!=null?{index:hn,scale:$i,extensions:H({},$)}:void 0,Ji=((y=(v=e.vectorProperties)==null?void 0:v._EmissionColor)!=null?y:[0,0,0,1]).map(ae),cn=(R=e.textureProperties)==null?void 0:R._EmissionMap,Ki=cn!=null?{index:cn,extensions:H({},$)}:void 0,er=((M=(T=e.vectorProperties)==null?void 0:T._ShadeColor)!=null?M:[.97,.81,.86,1]).map(ae),pn=(x=e.textureProperties)==null?void 0:x._ShadeTexture,tr=pn!=null?{index:pn,extensions:H({},$)}:void 0;let Ae=(P=(w=e.floatProperties)==null?void 0:w._ShadeShift)!=null?P:0,Pe=(E=(I=e.floatProperties)==null?void 0:I._ShadeToony)!=null?E:.9;Pe=N.lerp(Pe,1,.5+.5*Ae),Ae=-Ae-(1-Pe);const mn=(C=(b=e.floatProperties)==null?void 0:b._IndirectLightIntensity)!=null?C:.1,nr=mn?1-mn:void 0,$e=(G=e.textureProperties)==null?void 0:G._SphereAdd,ir=$e!=null?[1,1,1]:void 0,rr=$e!=null?{index:$e}:void 0,or=(fe=(me=e.floatProperties)==null?void 0:me._RimLightingMix)!=null?fe:0,fn=(z=e.textureProperties)==null?void 0:z._RimTexture,sr=fn!=null?{index:fn,extensions:H({},$)}:void 0,ar=((oe=(D=e.vectorProperties)==null?void 0:D._RimColor)!=null?oe:[0,0,0,1]).map(ae),lr=(V=(ge=e.floatProperties)==null?void 0:ge._RimFresnelPower)!=null?V:1,ur=(Wt=(kt=e.floatProperties)==null?void 0:kt._RimLift)!=null?Wt:0,dr=["none","worldCoordinates","screenCoordinates"][(Xt=(zt=e.floatProperties)==null?void 0:zt._OutlineWidthMode)!=null?Xt:0];let Ze=(Yt=(jt=e.floatProperties)==null?void 0:jt._OutlineWidth)!=null?Yt:0;Ze=.01*Ze;const gn=(Gt=e.textureProperties)==null?void 0:Gt._OutlineWidthTexture,hr=gn!=null?{index:gn,extensions:H({},$)}:void 0,cr=((Qt=(qt=e.vectorProperties)==null?void 0:qt._OutlineColor)!=null?Qt:[0,0,0]).map(ae),pr=((Zt=($t=e.floatProperties)==null?void 0:$t._OutlineColorMode)!=null?Zt:0)===1?(Kt=(Jt=e.floatProperties)==null?void 0:Jt._OutlineLightingMix)!=null?Kt:1:0,_n=(en=e.textureProperties)==null?void 0:en._UvAnimMaskTexture,mr=_n!=null?{index:_n,extensions:H({},$)}:void 0,fr=(nn=(tn=e.floatProperties)==null?void 0:tn._UvAnimScrollX)!=null?nn:0;let Ee=(on=(rn=e.floatProperties)==null?void 0:rn._UvAnimScrollY)!=null?on:0;Ee!=null&&(Ee=-Ee);const gr=(an=(sn=e.floatProperties)==null?void 0:sn._UvAnimRotation)!=null?an:0,_r={specVersion:"1.0",transparentWithZWrite:zi,renderQueueOffsetNumber:Xi,shadeColorFactor:er,shadeMultiplyTexture:tr,shadingShiftFactor:Ae,shadingToonyFactor:Pe,giEqualizationFactor:nr,matcapFactor:ir,matcapTexture:rr,rimLightingMixFactor:or,rimMultiplyTexture:sr,parametricRimColorFactor:ar,parametricRimFresnelPowerFactor:lr,parametricRimLiftFactor:ur,outlineWidthMode:dr,outlineWidthFactor:Ze,outlineWidthMultiplyTexture:hr,outlineColorFactor:cr,outlineLightingMixFactor:pr,uvAnimationMaskTexture:mr,uvAnimationScrollXSpeedFactor:fr,uvAnimationScrollYSpeedFactor:Ee,uvAnimationRotationSpeedFactor:gr};return zn(H({},t),{pbrMetallicRoughness:{baseColorFactor:qi,baseColorTexture:Qi},normalTexture:Zi,emissiveTexture:Ki,emissiveFactor:Ji,alphaMode:ji,alphaCutoff:Yi,doubleSided:Gi,extensions:{VRMC_materials_mtoon:_r}})}_parseV0UnlitProperties(e,t){var n,i,r,o,s;const l=e.shader==="VRM/UnlitTransparentZWrite",a=e.shader==="VRM/UnlitTransparent"||l,u=this._v0ParseRenderQueue(e),d=e.shader==="VRM/UnlitCutout",h=a?"BLEND":d?"MASK":"OPAQUE",c=d?(i=(n=e.floatProperties)==null?void 0:n._Cutoff)!=null?i:.5:void 0,p=this._portTextureTransform(e),f=((o=(r=e.vectorProperties)==null?void 0:r._Color)!=null?o:[1,1,1,1]).map(ae),m=(s=e.textureProperties)==null?void 0:s._MainTex,g=m!=null?{index:m,extensions:H({},p)}:void 0,v={specVersion:"1.0",transparentWithZWrite:l,renderQueueOffsetNumber:u,shadeColorFactor:f,shadeMultiplyTexture:g};return zn(H({},t),{pbrMetallicRoughness:{baseColorFactor:f,baseColorTexture:g},alphaMode:h,alphaCutoff:c,extensions:{VRMC_materials_mtoon:v}})}_portTextureTransform(e){var t,n,i,r,o;const s=(t=e.vectorProperties)==null?void 0:t._MainTex;if(s==null)return{};const l=[(n=s?.[0])!=null?n:0,(i=s?.[1])!=null?i:0],a=[(r=s?.[2])!=null?r:1,(o=s?.[3])!=null?o:1];return l[1]=1-a[1]-l[1],{KHR_texture_transform:{offset:l,scale:a}}}_v0ParseRenderQueue(e){var t,n;const i=e.shader==="VRM/UnlitTransparentZWrite",r=((t=e.keywordMap)==null?void 0:t._ALPHABLEND_ON)!=null||e.shader==="VRM/UnlitTransparent"||i,o=((n=e.floatProperties)==null?void 0:n._ZWrite)===1||i;let s=0;if(r){const l=e.renderQueue;l!=null&&(o?s=this._renderQueueMapTransparentZWrite.get(l):s=this._renderQueueMapTransparent.get(l))}return s}_populateRenderQueueMap(e){const t=new Set,n=new Set;e.forEach(i=>{var r,o;const s=i.shader==="VRM/UnlitTransparentZWrite",l=((r=i.keywordMap)==null?void 0:r._ALPHABLEND_ON)!=null||i.shader==="VRM/UnlitTransparent"||s,a=((o=i.floatProperties)==null?void 0:o._ZWrite)===1||s;if(l){const u=i.renderQueue;u!=null&&(a?n.add(u):t.add(u))}}),t.size>10&&console.warn(`VRMMaterialsV0CompatPlugin: This VRM uses ${t.size} render queues for Transparent materials while VRM 1.0 only supports up to 10 render queues. The model might not be rendered correctly.`),n.size>10&&console.warn(`VRMMaterialsV0CompatPlugin: This VRM uses ${n.size} render queues for TransparentZWrite materials while VRM 1.0 only supports up to 10 render queues. The model might not be rendered correctly.`),Array.from(t).sort().forEach((i,r)=>{const o=Math.min(Math.max(r-t.size+1,-9),0);this._renderQueueMapTransparent.set(i,o)}),Array.from(n).sort().forEach((i,r)=>{const o=Math.min(Math.max(r,0),9);this._renderQueueMapTransparentZWrite.set(i,o)})}},Xn=(e,t,n)=>new Promise((i,r)=>{var o=a=>{try{l(n.next(a))}catch(u){r(u)}},s=a=>{try{l(n.throw(a))}catch(u){r(u)}},l=a=>a.done?i(a.value):Promise.resolve(a.value).then(o,s);l((n=n.apply(e,t)).next())}),q=new _,Ve=class extends pe{constructor(e){super(),this._attrPosition=new U(new Float32Array([0,0,0,0,0,0]),3),this._attrPosition.setUsage(Ar);const t=new Y;t.setAttribute("position",this._attrPosition);const n=new Ye({color:16711935,depthTest:!1,depthWrite:!1});this._line=new Pr(t,n),this.add(this._line),this.constraint=e}updateMatrixWorld(e){q.setFromMatrixPosition(this.constraint.destination.matrixWorld),this._attrPosition.setXYZ(0,q.x,q.y,q.z),this.constraint.source&&q.setFromMatrixPosition(this.constraint.source.matrixWorld),this._attrPosition.setXYZ(1,q.x,q.y,q.z),this._attrPosition.needsUpdate=!0,super.updateMatrixWorld(e)}};function jn(e,t){return t.set(e.elements[12],e.elements[13],e.elements[14])}var Bo=new _,Ho=new _;function ko(e,t){return e.decompose(Bo,t,Ho),t}function ze(e){return e.invert?e.invert():e.inverse(),e}var Ge=class{constructor(e,t){this.destination=e,this.source=t,this.weight=1}},Wo=new _,zo=new _,Xo=new _,jo=new A,Yo=new A,Go=new A,Pi=class extends Ge{get aimAxis(){return this._aimAxis}set aimAxis(e){this._aimAxis=e,this._v3AimAxis.set(e==="PositiveX"?1:e==="NegativeX"?-1:0,e==="PositiveY"?1:e==="NegativeY"?-1:0,e==="PositiveZ"?1:e==="NegativeZ"?-1:0)}get dependencies(){const e=new Set([this.source]);return this.destination.parent&&e.add(this.destination.parent),e}constructor(e,t){super(e,t),this._aimAxis="PositiveX",this._v3AimAxis=new _(1,0,0),this._dstRestQuat=new A}setInitState(){this._dstRestQuat.copy(this.destination.quaternion)}update(){this.destination.updateWorldMatrix(!0,!1),this.source.updateWorldMatrix(!0,!1);const e=jo.identity(),t=Yo.identity();this.destination.parent&&(ko(this.destination.parent.matrixWorld,e),ze(t.copy(e)));const n=Wo.copy(this._v3AimAxis).applyQuaternion(this._dstRestQuat).applyQuaternion(e),i=jn(this.source.matrixWorld,zo).sub(jn(this.destination.matrixWorld,Xo)).normalize(),r=Go.setFromUnitVectors(n,i).premultiply(t).multiply(e).multiply(this._dstRestQuat);this.destination.quaternion.copy(this._dstRestQuat).slerp(r,this.weight)}};function qo(e,t){const n=[e];let i=e.parent;for(;i!==null;)n.unshift(i),i=i.parent;n.forEach(r=>{t(r)})}var Ei=class{constructor(){this._constraints=new Set,this._objectConstraintsMap=new Map}get constraints(){return this._constraints}addConstraint(e){this._constraints.add(e);let t=this._objectConstraintsMap.get(e.destination);t==null&&(t=new Set,this._objectConstraintsMap.set(e.destination,t)),t.add(e)}deleteConstraint(e){this._constraints.delete(e),this._objectConstraintsMap.get(e.destination).delete(e)}setInitState(){const e=new Set,t=new Set;for(const n of this._constraints)this._processConstraint(n,e,t,i=>i.setInitState())}update(){const e=new Set,t=new Set;for(const n of this._constraints)this._processConstraint(n,e,t,i=>i.update())}_processConstraint(e,t,n,i){if(n.has(e))return;if(t.has(e))throw new Error("VRMNodeConstraintManager: Circular dependency detected while updating constraints");t.add(e);const r=e.dependencies;for(const o of r)qo(o,s=>{const l=this._objectConstraintsMap.get(s);if(l)for(const a of l)this._processConstraint(a,t,n,i)});i(e),n.add(e)}},Qo=new A,$o=new A,Li=class extends Ge{get dependencies(){return new Set([this.source])}constructor(e,t){super(e,t),this._dstRestQuat=new A,this._invSrcRestQuat=new A}setInitState(){this._dstRestQuat.copy(this.destination.quaternion),ze(this._invSrcRestQuat.copy(this.source.quaternion))}update(){const e=Qo.copy(this._invSrcRestQuat).multiply(this.source.quaternion),t=$o.copy(this._dstRestQuat).multiply(e);this.destination.quaternion.copy(this._dstRestQuat).slerp(t,this.weight)}},Zo=new _,Jo=new A,Ko=new A,bi=class extends Ge{get rollAxis(){return this._rollAxis}set rollAxis(e){this._rollAxis=e,this._v3RollAxis.set(e==="X"?1:0,e==="Y"?1:0,e==="Z"?1:0)}get dependencies(){return new Set([this.source])}constructor(e,t){super(e,t),this._rollAxis="X",this._v3RollAxis=new _(1,0,0),this._dstRestQuat=new A,this._invDstRestQuat=new A,this._invSrcRestQuatMulDstRestQuat=new A}setInitState(){this._dstRestQuat.copy(this.destination.quaternion),ze(this._invDstRestQuat.copy(this._dstRestQuat)),ze(this._invSrcRestQuatMulDstRestQuat.copy(this.source.quaternion)).multiply(this._dstRestQuat)}update(){const e=Jo.copy(this._invDstRestQuat).multiply(this.source.quaternion).multiply(this._invSrcRestQuatMulDstRestQuat),t=Zo.copy(this._v3RollAxis).applyQuaternion(e),i=Ko.setFromUnitVectors(t,this._v3RollAxis).premultiply(this._dstRestQuat).multiply(e);this.destination.quaternion.copy(this._dstRestQuat).slerp(i,this.weight)}},es=new Set(["1.0","1.0-beta"]),Ii=class Te{get name(){return Te.EXTENSION_NAME}constructor(t,n){this.parser=t,this.helperRoot=n?.helperRoot}afterRoot(t){return Xn(this,null,function*(){t.userData.vrmNodeConstraintManager=yield this._import(t)})}_import(t){return Xn(this,null,function*(){var n;const i=this.parser.json;if(!(((n=i.extensionsUsed)==null?void 0:n.indexOf(Te.EXTENSION_NAME))!==-1))return null;const o=new Ei,s=yield this.parser.getDependencies("node");return s.forEach((l,a)=>{var u;const d=i.nodes[a],h=(u=d?.extensions)==null?void 0:u[Te.EXTENSION_NAME];if(h==null)return;const c=h.specVersion;if(!es.has(c)){console.warn(`VRMNodeConstraintLoaderPlugin: Unknown ${Te.EXTENSION_NAME} specVersion "${c}"`);return}const p=h.constraint;if(p.roll!=null){const f=this._importRollConstraint(l,s,p.roll);o.addConstraint(f)}else if(p.aim!=null){const f=this._importAimConstraint(l,s,p.aim);o.addConstraint(f)}else if(p.rotation!=null){const f=this._importRotationConstraint(l,s,p.rotation);o.addConstraint(f)}}),t.scene.updateMatrixWorld(),o.setInitState(),o})}_importRollConstraint(t,n,i){const{source:r,rollAxis:o,weight:s}=i,l=n[r],a=new bi(t,l);if(o!=null&&(a.rollAxis=o),s!=null&&(a.weight=s),this.helperRoot){const u=new Ve(a);this.helperRoot.add(u)}return a}_importAimConstraint(t,n,i){const{source:r,aimAxis:o,weight:s}=i,l=n[r],a=new Pi(t,l);if(o!=null&&(a.aimAxis=o),s!=null&&(a.weight=s),this.helperRoot){const u=new Ve(a);this.helperRoot.add(u)}return a}_importRotationConstraint(t,n,i){const{source:r,weight:o}=i,s=n[r],l=new Li(t,s);if(o!=null&&(l.weight=o),this.helperRoot){const a=new Ve(l);this.helperRoot.add(a)}return l}};Ii.EXTENSION_NAME="VRMC_node_constraint";var Ni=Ii,Ne=(e,t,n)=>new Promise((i,r)=>{var o=a=>{try{l(n.next(a))}catch(u){r(u)}},s=a=>{try{l(n.throw(a))}catch(u){r(u)}},l=a=>a.done?i(a.value):Promise.resolve(a.value).then(o,s);l((n=n.apply(e,t)).next())}),qe=class{},rt=new _,K=new _,Dt=class extends qe{get type(){return"capsule"}constructor(e){var t,n,i,r;super(),this.offset=(t=e?.offset)!=null?t:new _(0,0,0),this.tail=(n=e?.tail)!=null?n:new _(0,0,0),this.radius=(i=e?.radius)!=null?i:0,this.inside=(r=e?.inside)!=null?r:!1}calculateCollision(e,t,n,i){rt.setFromMatrixPosition(e),K.subVectors(this.tail,this.offset).applyMatrix4(e),K.sub(rt);const r=K.lengthSq();i.copy(t).sub(rt);const o=K.dot(i);o<=0||(r<=o||K.multiplyScalar(o/r),i.sub(K));const s=i.length(),l=this.inside?this.radius-n-s:s-n-this.radius;return l<0&&(i.multiplyScalar(1/s),this.inside&&i.negate()),l}},ot=new _,Yn=new W,Bt=class extends qe{get type(){return"plane"}constructor(e){var t,n;super(),this.offset=(t=e?.offset)!=null?t:new _(0,0,0),this.normal=(n=e?.normal)!=null?n:new _(0,0,1)}calculateCollision(e,t,n,i){i.setFromMatrixPosition(e),i.negate().add(t),Yn.getNormalMatrix(e),ot.copy(this.normal).applyNormalMatrix(Yn).normalize();const r=i.dot(ot)-n;return i.copy(ot),r}},ts=new _,Ht=class extends qe{get type(){return"sphere"}constructor(e){var t,n,i;super(),this.offset=(t=e?.offset)!=null?t:new _(0,0,0),this.radius=(n=e?.radius)!=null?n:0,this.inside=(i=e?.inside)!=null?i:!1}calculateCollision(e,t,n,i){i.subVectors(t,ts.setFromMatrixPosition(e));const r=i.length(),o=this.inside?this.radius-n-r:r-n-this.radius;return o<0&&(i.multiplyScalar(1/r),this.inside&&i.negate()),o}},k=new _,ns=class extends Y{constructor(e){super(),this.worldScale=1,this._currentRadius=0,this._currentOffset=new _,this._currentTail=new _,this._shape=e,this._attrPos=new U(new Float32Array(396),3),this.setAttribute("position",this._attrPos),this._attrIndex=new U(new Uint16Array(264),1),this.setIndex(this._attrIndex),this._buildIndex(),this.update()}update(){let e=!1;const t=this._shape.radius/this.worldScale;this._currentRadius!==t&&(this._currentRadius=t,e=!0),this._currentOffset.equals(this._shape.offset)||(this._currentOffset.copy(this._shape.offset),e=!0);const n=k.copy(this._shape.tail).divideScalar(this.worldScale);this._currentTail.distanceToSquared(n)>1e-10&&(this._currentTail.copy(n),e=!0),e&&this._buildPosition()}_buildPosition(){k.copy(this._currentTail).sub(this._currentOffset);const e=k.length()/this._currentRadius;for(let i=0;i<=16;i++){const r=i/16*Math.PI;this._attrPos.setXYZ(i,-Math.sin(r),-Math.cos(r),0),this._attrPos.setXYZ(17+i,e+Math.sin(r),Math.cos(r),0),this._attrPos.setXYZ(34+i,-Math.sin(r),0,-Math.cos(r)),this._attrPos.setXYZ(51+i,e+Math.sin(r),0,Math.cos(r))}for(let i=0;i<32;i++){const r=i/16*Math.PI;this._attrPos.setXYZ(68+i,0,Math.sin(r),Math.cos(r)),this._attrPos.setXYZ(100+i,e,Math.sin(r),Math.cos(r))}const t=Math.atan2(k.y,Math.sqrt(k.x*k.x+k.z*k.z)),n=-Math.atan2(k.z,k.x);this.rotateZ(t),this.rotateY(n),this.scale(this._currentRadius,this._currentRadius,this._currentRadius),this.translate(this._currentOffset.x,this._currentOffset.y,this._currentOffset.z),this._attrPos.needsUpdate=!0}_buildIndex(){for(let e=0;e<34;e++){const t=(e+1)%34;this._attrIndex.setXY(e*2,e,t),this._attrIndex.setXY(68+e*2,34+e,34+t)}for(let e=0;e<32;e++){const t=(e+1)%32;this._attrIndex.setXY(136+e*2,68+e,68+t),this._attrIndex.setXY(200+e*2,100+e,100+t)}this._attrIndex.needsUpdate=!0}},is=class extends Y{constructor(e){super(),this.worldScale=1,this._currentOffset=new _,this._currentNormal=new _,this._shape=e,this._attrPos=new U(new Float32Array(18),3),this.setAttribute("position",this._attrPos),this._attrIndex=new U(new Uint16Array(10),1),this.setIndex(this._attrIndex),this._buildIndex(),this.update()}update(){let e=!1;this._currentOffset.equals(this._shape.offset)||(this._currentOffset.copy(this._shape.offset),e=!0),this._currentNormal.equals(this._shape.normal)||(this._currentNormal.copy(this._shape.normal),e=!0),e&&this._buildPosition()}_buildPosition(){this._attrPos.setXYZ(0,-.5,-.5,0),this._attrPos.setXYZ(1,.5,-.5,0),this._attrPos.setXYZ(2,.5,.5,0),this._attrPos.setXYZ(3,-.5,.5,0),this._attrPos.setXYZ(4,0,0,0),this._attrPos.setXYZ(5,0,0,.25),this.translate(this._currentOffset.x,this._currentOffset.y,this._currentOffset.z),this.lookAt(this._currentNormal),this._attrPos.needsUpdate=!0}_buildIndex(){this._attrIndex.setXY(0,0,1),this._attrIndex.setXY(2,1,2),this._attrIndex.setXY(4,2,3),this._attrIndex.setXY(6,3,0),this._attrIndex.setXY(8,4,5),this._attrIndex.needsUpdate=!0}},rs=class extends Y{constructor(e){super(),this.worldScale=1,this._currentRadius=0,this._currentOffset=new _,this._shape=e,this._attrPos=new U(new Float32Array(288),3),this.setAttribute("position",this._attrPos),this._attrIndex=new U(new Uint16Array(192),1),this.setIndex(this._attrIndex),this._buildIndex(),this.update()}update(){let e=!1;const t=this._shape.radius/this.worldScale;this._currentRadius!==t&&(this._currentRadius=t,e=!0),this._currentOffset.equals(this._shape.offset)||(this._currentOffset.copy(this._shape.offset),e=!0),e&&this._buildPosition()}_buildPosition(){for(let e=0;e<32;e++){const t=e/16*Math.PI;this._attrPos.setXYZ(e,Math.cos(t),Math.sin(t),0),this._attrPos.setXYZ(32+e,0,Math.cos(t),Math.sin(t)),this._attrPos.setXYZ(64+e,Math.sin(t),0,Math.cos(t))}this.scale(this._currentRadius,this._currentRadius,this._currentRadius),this.translate(this._currentOffset.x,this._currentOffset.y,this._currentOffset.z),this._attrPos.needsUpdate=!0}_buildIndex(){for(let e=0;e<32;e++){const t=(e+1)%32;this._attrIndex.setXY(e*2,e,t),this._attrIndex.setXY(64+e*2,32+e,32+t),this._attrIndex.setXY(128+e*2,64+e,64+t)}this._attrIndex.needsUpdate=!0}},os=new _,Fe=class extends pe{constructor(e){if(super(),this.matrixAutoUpdate=!1,this.collider=e,this.collider.shape instanceof Ht)this._geometry=new rs(this.collider.shape);else if(this.collider.shape instanceof Dt)this._geometry=new ns(this.collider.shape);else if(this.collider.shape instanceof Bt)this._geometry=new is(this.collider.shape);else throw new Error("VRMSpringBoneColliderHelper: Unknown collider shape type detected");const t=new Ye({color:16711935,depthTest:!1,depthWrite:!1});this._line=new Lt(this._geometry,t),this.add(this._line)}dispose(){this._geometry.dispose()}updateMatrixWorld(e){this.collider.updateWorldMatrix(!0,!1),this.matrix.copy(this.collider.matrixWorld);const t=this.matrix.elements;this._geometry.worldScale=os.set(t[0],t[1],t[2]).length(),this._geometry.update(),super.updateMatrixWorld(e)}},ss=class extends Y{constructor(e){super(),this.worldScale=1,this._currentRadius=0,this._currentTail=new _,this._springBone=e,this._attrPos=new U(new Float32Array(294),3),this.setAttribute("position",this._attrPos),this._attrIndex=new U(new Uint16Array(194),1),this.setIndex(this._attrIndex),this._buildIndex(),this.update()}update(){let e=!1;const t=this._springBone.settings.hitRadius/this.worldScale;this._currentRadius!==t&&(this._currentRadius=t,e=!0),this._currentTail.equals(this._springBone.initialLocalChildPosition)||(this._currentTail.copy(this._springBone.initialLocalChildPosition),e=!0),e&&this._buildPosition()}_buildPosition(){for(let e=0;e<32;e++){const t=e/16*Math.PI;this._attrPos.setXYZ(e,Math.cos(t),Math.sin(t),0),this._attrPos.setXYZ(32+e,0,Math.cos(t),Math.sin(t)),this._attrPos.setXYZ(64+e,Math.sin(t),0,Math.cos(t))}this.scale(this._currentRadius,this._currentRadius,this._currentRadius),this.translate(this._currentTail.x,this._currentTail.y,this._currentTail.z),this._attrPos.setXYZ(96,0,0,0),this._attrPos.setXYZ(97,this._currentTail.x,this._currentTail.y,this._currentTail.z),this._attrPos.needsUpdate=!0}_buildIndex(){for(let e=0;e<32;e++){const t=(e+1)%32;this._attrIndex.setXY(e*2,e,t),this._attrIndex.setXY(64+e*2,32+e,32+t),this._attrIndex.setXY(128+e*2,64+e,64+t)}this._attrIndex.setXY(192,96,97),this._attrIndex.needsUpdate=!0}},as=new _,Ci=class extends pe{constructor(e){super(),this.matrixAutoUpdate=!1,this.springBone=e,this._geometry=new ss(this.springBone);const t=new Ye({color:16776960,depthTest:!1,depthWrite:!1});this._line=new Lt(this._geometry,t),this.add(this._line)}dispose(){this._geometry.dispose()}updateMatrixWorld(e){this.springBone.bone.updateWorldMatrix(!0,!1),this.matrix.copy(this.springBone.bone.matrixWorld);const t=this.matrix.elements;this._geometry.worldScale=as.set(t[0],t[1],t[2]).length(),this._geometry.update(),super.updateMatrixWorld(e)}},De=class extends Be{constructor(e){super(),this.colliderMatrix=new j,this.shape=e}updateWorldMatrix(e,t){super.updateWorldMatrix(e,t),ls(this.colliderMatrix,this.matrixWorld,this.shape.offset)}};function ls(e,t,n){const i=t.elements;e.copy(t),n&&(e.elements[12]=i[0]*n.x+i[4]*n.y+i[8]*n.z+i[12],e.elements[13]=i[1]*n.x+i[5]*n.y+i[9]*n.z+i[13],e.elements[14]=i[2]*n.x+i[6]*n.y+i[10]*n.z+i[14])}var us=new j;function ds(e){return e.invert?e.invert():e.getInverse(us.copy(e)),e}var hs=class{constructor(e){this._inverseCache=new j,this._shouldUpdateInverse=!0,this.matrix=e;const t={set:(n,i,r)=>(this._shouldUpdateInverse=!0,n[i]=r,!0)};this._originalElements=e.elements,e.elements=new Proxy(e.elements,t)}get inverse(){return this._shouldUpdateInverse&&(ds(this._inverseCache.copy(this.matrix)),this._shouldUpdateInverse=!1),this._inverseCache}revert(){this.matrix.elements=this._originalElements}},st=new j,le=new _,Me=new _,xe=new _,ye=new _,cs=new j,Oi=class{constructor(e,t,n={},i=[]){this._currentTail=new _,this._prevTail=new _,this._boneAxis=new _,this._worldSpaceBoneLength=0,this._center=null,this._initialLocalMatrix=new j,this._initialLocalRotation=new A,this._initialLocalChildPosition=new _;var r,o,s,l,a,u;this.bone=e,this.bone.matrixAutoUpdate=!1,this.child=t,this.settings={hitRadius:(r=n.hitRadius)!=null?r:0,stiffness:(o=n.stiffness)!=null?o:1,gravityPower:(s=n.gravityPower)!=null?s:0,gravityDir:(a=(l=n.gravityDir)==null?void 0:l.clone())!=null?a:new _(0,-1,0),dragForce:(u=n.dragForce)!=null?u:.4},this.colliderGroups=i}get dependencies(){const e=new Set,t=this.bone.parent;t&&e.add(t);for(let n=0;n<this.colliderGroups.length;n++)for(let i=0;i<this.colliderGroups[n].colliders.length;i++)e.add(this.colliderGroups[n].colliders[i]);return e}get center(){return this._center}set center(e){var t;(t=this._center)!=null&&t.userData.inverseCacheProxy&&(this._center.userData.inverseCacheProxy.revert(),delete this._center.userData.inverseCacheProxy),this._center=e,this._center&&(this._center.userData.inverseCacheProxy||(this._center.userData.inverseCacheProxy=new hs(this._center.matrixWorld)))}get initialLocalChildPosition(){return this._initialLocalChildPosition}get _parentMatrixWorld(){return this.bone.parent?this.bone.parent.matrixWorld:st}setInitState(){this._initialLocalMatrix.copy(this.bone.matrix),this._initialLocalRotation.copy(this.bone.quaternion),this.child?this._initialLocalChildPosition.copy(this.child.position):this._initialLocalChildPosition.copy(this.bone.position).normalize().multiplyScalar(.07);const e=this._getMatrixWorldToCenter();this.bone.localToWorld(this._currentTail.copy(this._initialLocalChildPosition)).applyMatrix4(e),this._prevTail.copy(this._currentTail),this._boneAxis.copy(this._initialLocalChildPosition).normalize()}reset(){this.bone.quaternion.copy(this._initialLocalRotation),this.bone.updateMatrix(),this.bone.matrixWorld.multiplyMatrices(this._parentMatrixWorld,this.bone.matrix);const e=this._getMatrixWorldToCenter();this.bone.localToWorld(this._currentTail.copy(this._initialLocalChildPosition)).applyMatrix4(e),this._prevTail.copy(this._currentTail)}update(e){if(e<=0)return;this._calcWorldSpaceBoneLength();const t=Me.copy(this._boneAxis).transformDirection(this._initialLocalMatrix).transformDirection(this._parentMatrixWorld);ye.copy(this._currentTail).add(le.subVectors(this._currentTail,this._prevTail).multiplyScalar(1-this.settings.dragForce)).applyMatrix4(this._getMatrixCenterToWorld()).addScaledVector(t,this.settings.stiffness*e).addScaledVector(this.settings.gravityDir,this.settings.gravityPower*e),xe.setFromMatrixPosition(this.bone.matrixWorld),ye.sub(xe).normalize().multiplyScalar(this._worldSpaceBoneLength).add(xe),this._collision(ye),this._prevTail.copy(this._currentTail),this._currentTail.copy(ye).applyMatrix4(this._getMatrixWorldToCenter());const n=cs.multiplyMatrices(this._parentMatrixWorld,this._initialLocalMatrix).invert();this.bone.quaternion.setFromUnitVectors(this._boneAxis,le.copy(ye).applyMatrix4(n).normalize()).premultiply(this._initialLocalRotation),this.bone.updateMatrix(),this.bone.matrixWorld.multiplyMatrices(this._parentMatrixWorld,this.bone.matrix)}_collision(e){for(let t=0;t<this.colliderGroups.length;t++)for(let n=0;n<this.colliderGroups[t].colliders.length;n++){const i=this.colliderGroups[t].colliders[n],r=i.shape.calculateCollision(i.colliderMatrix,e,this.settings.hitRadius,le);if(r<0){e.addScaledVector(le,-r),e.sub(xe);const o=e.length();e.multiplyScalar(this._worldSpaceBoneLength/o).add(xe)}}}_calcWorldSpaceBoneLength(){le.setFromMatrixPosition(this.bone.matrixWorld),this.child?Me.setFromMatrixPosition(this.child.matrixWorld):(Me.copy(this._initialLocalChildPosition),Me.applyMatrix4(this.bone.matrixWorld)),this._worldSpaceBoneLength=le.sub(Me).length()}_getMatrixCenterToWorld(){return this._center?this._center.matrixWorld:st}_getMatrixWorldToCenter(){return this._center?this._center.userData.inverseCacheProxy.inverse:st}};function ps(e,t){const n=[];let i=e;for(;i!==null;)n.unshift(i),i=i.parent;n.forEach(r=>{t(r)})}function yt(e,t){e.children.forEach(n=>{t(n)||yt(n,t)})}function ms(e){var t;const n=new Map;for(const i of e){let r=i;do{const o=((t=n.get(r))!=null?t:0)+1;if(o===e.size)return r;n.set(r,o),r=r.parent}while(r!==null)}return null}var Rt=class{constructor(){this._joints=new Set,this._sortedJoints=[],this._hasWarnedCircularDependency=!1,this._ancestors=[],this._objectSpringBonesMap=new Map,this._isSortedJointsDirty=!1,this._relevantChildrenUpdated=this._relevantChildrenUpdated.bind(this)}get joints(){return this._joints}get springBones(){return console.warn("VRMSpringBoneManager: springBones is deprecated. use joints instead."),this._joints}get colliderGroups(){const e=new Set;return this._joints.forEach(t=>{t.colliderGroups.forEach(n=>{e.add(n)})}),Array.from(e)}get colliders(){const e=new Set;return this.colliderGroups.forEach(t=>{t.colliders.forEach(n=>{e.add(n)})}),Array.from(e)}addJoint(e){this._joints.add(e);let t=this._objectSpringBonesMap.get(e.bone);t==null&&(t=new Set,this._objectSpringBonesMap.set(e.bone,t)),t.add(e),this._isSortedJointsDirty=!0}addSpringBone(e){console.warn("VRMSpringBoneManager: addSpringBone() is deprecated. use addJoint() instead."),this.addJoint(e)}deleteJoint(e){this._joints.delete(e),this._objectSpringBonesMap.get(e.bone).delete(e),this._isSortedJointsDirty=!0}deleteSpringBone(e){console.warn("VRMSpringBoneManager: deleteSpringBone() is deprecated. use deleteJoint() instead."),this.deleteJoint(e)}setInitState(){this._sortJoints();for(let e=0;e<this._sortedJoints.length;e++){const t=this._sortedJoints[e];t.bone.updateMatrix(),t.bone.updateWorldMatrix(!1,!1),t.setInitState()}}reset(){this._sortJoints();for(let e=0;e<this._sortedJoints.length;e++){const t=this._sortedJoints[e];t.bone.updateMatrix(),t.bone.updateWorldMatrix(!1,!1),t.reset()}}update(e){this._sortJoints();for(let t=0;t<this._ancestors.length;t++)this._ancestors[t].updateWorldMatrix(t===0,!1);for(let t=0;t<this._sortedJoints.length;t++){const n=this._sortedJoints[t];n.bone.updateMatrix(),n.bone.updateWorldMatrix(!1,!1),n.update(e),yt(n.bone,this._relevantChildrenUpdated)}}_sortJoints(){if(!this._isSortedJointsDirty)return;const e=[],t=new Set,n=new Set,i=new Set;for(const o of this._joints)this._insertJointSort(o,t,n,e,i);this._sortedJoints=e;const r=ms(i);this._ancestors=[],r&&(this._ancestors.push(r),yt(r,o=>{var s,l;return((l=(s=this._objectSpringBonesMap.get(o))==null?void 0:s.size)!=null?l:0)>0?!0:(this._ancestors.push(o),!1)})),this._isSortedJointsDirty=!1}_insertJointSort(e,t,n,i,r){if(n.has(e))return;if(t.has(e)){this._hasWarnedCircularDependency||(console.warn("VRMSpringBoneManager: Circular dependency detected"),this._hasWarnedCircularDependency=!0);return}t.add(e);const o=e.dependencies;for(const s of o){let l=!1,a=null;ps(s,u=>{const d=this._objectSpringBonesMap.get(u);if(d)for(const h of d)l=!0,this._insertJointSort(h,t,n,i,r);else l||(a=u)}),a&&r.add(a)}i.push(e),n.add(e)}_relevantChildrenUpdated(e){var t,n;return((n=(t=this._objectSpringBonesMap.get(e))==null?void 0:t.size)!=null?n:0)>0?!0:(e.updateWorldMatrix(!1,!1),!1)}},Gn="VRMC_springBone_extended_collider",fs=new Set(["1.0","1.0-beta"]),gs=new Set(["1.0"]),Ui=class he{get name(){return he.EXTENSION_NAME}constructor(t,n){var i;this.parser=t,this.jointHelperRoot=n?.jointHelperRoot,this.colliderHelperRoot=n?.colliderHelperRoot,this.useExtendedColliders=(i=n?.useExtendedColliders)!=null?i:!0}afterRoot(t){return Ne(this,null,function*(){t.userData.vrmSpringBoneManager=yield this._import(t)})}_import(t){return Ne(this,null,function*(){const n=yield this._v1Import(t);if(n!=null)return n;const i=yield this._v0Import(t);return i??null})}_v1Import(t){return Ne(this,null,function*(){var n,i,r,o,s;const l=t.parser.json;if(!(((n=l.extensionsUsed)==null?void 0:n.indexOf(he.EXTENSION_NAME))!==-1))return null;const u=new Rt,d=yield t.parser.getDependencies("node"),h=(i=l.extensions)==null?void 0:i[he.EXTENSION_NAME];if(!h)return null;const c=h.specVersion;if(!fs.has(c))return console.warn(`VRMSpringBoneLoaderPlugin: Unknown ${he.EXTENSION_NAME} specVersion "${c}"`),null;const p=(r=h.colliders)==null?void 0:r.map((m,g)=>{var v,y,R,T,M,x,w,P,I,E,b,C,G,me,fe;const z=d[m.node];if(z==null)return console.warn(`VRMSpringBoneLoaderPlugin: The collider #${g} attempted to reference a node #${m.node} but not found. Skipping the collider`),null;const D=m.shape,oe=(v=m.extensions)==null?void 0:v[Gn];if(this.useExtendedColliders&&oe!=null){const ge=oe.specVersion;if(!gs.has(ge))console.warn(`VRMSpringBoneLoaderPlugin: Unknown ${Gn} specVersion "${ge}". Fallbacking to the ${he.EXTENSION_NAME} definition`);else{const V=oe.shape;if(V.sphere)return this._importSphereCollider(z,{offset:new _().fromArray((y=V.sphere.offset)!=null?y:[0,0,0]),radius:(R=V.sphere.radius)!=null?R:0,inside:(T=V.sphere.inside)!=null?T:!1});if(V.capsule)return this._importCapsuleCollider(z,{offset:new _().fromArray((M=V.capsule.offset)!=null?M:[0,0,0]),radius:(x=V.capsule.radius)!=null?x:0,tail:new _().fromArray((w=V.capsule.tail)!=null?w:[0,0,0]),inside:(P=V.capsule.inside)!=null?P:!1});if(V.plane)return this._importPlaneCollider(z,{offset:new _().fromArray((I=V.plane.offset)!=null?I:[0,0,0]),normal:new _().fromArray((E=V.plane.normal)!=null?E:[0,0,1])})}}if(D.sphere)return this._importSphereCollider(z,{offset:new _().fromArray((b=D.sphere.offset)!=null?b:[0,0,0]),radius:(C=D.sphere.radius)!=null?C:0,inside:!1});if(D.capsule)return this._importCapsuleCollider(z,{offset:new _().fromArray((G=D.capsule.offset)!=null?G:[0,0,0]),radius:(me=D.capsule.radius)!=null?me:0,tail:new _().fromArray((fe=D.capsule.tail)!=null?fe:[0,0,0]),inside:!1});console.warn(`VRMSpringBoneLoaderPlugin: The collider #${g} has no valid shape. Skipping the collider`)}),f=(o=h.colliderGroups)==null?void 0:o.map((m,g)=>{var v;return{colliders:((v=m.colliders)!=null?v:[]).map(R=>{const T=p?.[R];return T??(console.warn(`VRMSpringBoneLoaderPlugin: The collider group #${g} attempted to reference a collider #${R} but not found. Skipping the collider`),null)}).filter(R=>R!=null),name:m.name}});return(s=h.springs)==null||s.forEach((m,g)=>{var v;const y=m.joints,R=(v=m.colliderGroups)==null?void 0:v.map(x=>{const w=f?.[x];return w??(console.warn(`VRMSpringBoneLoaderPlugin: The spring #${g} attempted to reference a collider group #${x} but not found. Skipping the collider group`),null)}).filter(x=>x!=null),T=m.center!=null?d[m.center]:void 0;let M;y.forEach(x=>{if(M){const w=M.node,P=d[w],I=x.node,E=d[I],b={hitRadius:M.hitRadius,dragForce:M.dragForce,gravityPower:M.gravityPower,stiffness:M.stiffness,gravityDir:M.gravityDir!=null?new _().fromArray(M.gravityDir):void 0},C=this._importJoint(P,E,b,R);T&&(C.center=T),u.addJoint(C)}M=x})}),u.setInitState(),u})}_v0Import(t){return Ne(this,null,function*(){var n,i,r;const o=t.parser.json;if(!(((n=o.extensionsUsed)==null?void 0:n.indexOf("VRM"))!==-1))return null;const l=(i=o.extensions)==null?void 0:i.VRM,a=l?.secondaryAnimation;if(!a)return null;const u=a?.boneGroups;if(!u)return null;const d=new Rt,h=yield t.parser.getDependencies("node"),c=(r=a.colliderGroups)==null?void 0:r.map((p,f)=>{var m;const g=h[p.node];return g==null?(console.warn(`VRMSpringBoneLoaderPlugin: The collider group #${f} attempted to reference a node #${p.node} but not found. Skipping the collider group`),null):{colliders:((m=p.colliders)!=null?m:[]).map((y,R)=>{var T,M,x;const w=new _(0,0,0);return y.offset&&w.set((T=y.offset.x)!=null?T:0,(M=y.offset.y)!=null?M:0,y.offset.z?-y.offset.z:0),this._importSphereCollider(g,{offset:w,radius:(x=y.radius)!=null?x:0,inside:!1})})}});return u?.forEach((p,f)=>{const m=p.bones;m&&m.forEach(g=>{var v,y,R,T;const M=h[g];if(M==null){console.warn(`VRMSpringBoneLoaderPlugin: The spring bone group #${f} attempted to reference a node #${g} but not found. Skipping the node`);return}const x=new _;p.gravityDir?x.set((v=p.gravityDir.x)!=null?v:0,(y=p.gravityDir.y)!=null?y:0,(R=p.gravityDir.z)!=null?R:0):x.set(0,-1,0);const w=p.center!=null?h[p.center]:void 0,P={hitRadius:p.hitRadius,dragForce:p.dragForce,gravityPower:p.gravityPower,stiffness:p.stiffiness,gravityDir:x},I=(T=p.colliderGroups)==null?void 0:T.map(E=>{const b=c?.[E];return b??(console.warn(`VRMSpringBoneLoaderPlugin: The spring #${f} attempted to reference a collider group #${E} but not found. Skipping the collider group`),null)}).filter(E=>E!=null);M.traverse(E=>{var b;const C=(b=E.children[0])!=null?b:null,G=this._importJoint(E,C,P,I);w&&(G.center=w),d.addJoint(G)})})}),t.scene.updateMatrixWorld(),d.setInitState(),d})}_importJoint(t,n,i,r){const o=new Oi(t,n,i,r);if(this.jointHelperRoot){const s=new Ci(o);this.jointHelperRoot.add(s),s.renderOrder=this.jointHelperRoot.renderOrder}return o}_importSphereCollider(t,n){const i=new Ht(n),r=new De(i);if(t.add(r),this.colliderHelperRoot){const o=new Fe(r);this.colliderHelperRoot.add(o),o.renderOrder=this.colliderHelperRoot.renderOrder}return r}_importCapsuleCollider(t,n){const i=new Dt(n),r=new De(i);if(t.add(r),this.colliderHelperRoot){const o=new Fe(r);this.colliderHelperRoot.add(o),o.renderOrder=this.colliderHelperRoot.renderOrder}return r}_importPlaneCollider(t,n){const i=new Bt(n),r=new De(i);if(t.add(r),this.colliderHelperRoot){const o=new Fe(r);this.colliderHelperRoot.add(o),o.renderOrder=this.colliderHelperRoot.renderOrder}return r}};Ui.EXTENSION_NAME="VRMC_springBone";var Vi=Ui,_s=class{get name(){return"VRMLoaderPlugin"}constructor(e,t){var n,i,r,o,s,l,a,u,d,h;this.parser=e;const c=t?.helperRoot,p=t?.autoUpdateHumanBones;this.expressionPlugin=(n=t?.expressionPlugin)!=null?n:new It(e),this.firstPersonPlugin=(i=t?.firstPersonPlugin)!=null?i:new Ct(e),this.humanoidPlugin=(r=t?.humanoidPlugin)!=null?r:new Ot(e,{helperRoot:c,autoUpdateHumanBones:p}),this.lookAtPlugin=(o=t?.lookAtPlugin)!=null?o:new Ut(e,{helperRoot:c}),this.metaPlugin=(s=t?.metaPlugin)!=null?s:new Vt(e),this.mtoonMaterialPlugin=(l=t?.mtoonMaterialPlugin)!=null?l:new Si(e),this.materialsHDREmissiveMultiplierPlugin=(a=t?.materialsHDREmissiveMultiplierPlugin)!=null?a:new Io(e),this.materialsV0CompatPlugin=(u=t?.materialsV0CompatPlugin)!=null?u:new Do(e),this.springBonePlugin=(d=t?.springBonePlugin)!=null?d:new Vi(e,{colliderHelperRoot:c,jointHelperRoot:c}),this.nodeConstraintPlugin=(h=t?.nodeConstraintPlugin)!=null?h:new Ni(e,{helperRoot:c})}beforeRoot(){return Le(this,null,function*(){yield this.materialsV0CompatPlugin.beforeRoot(),yield this.mtoonMaterialPlugin.beforeRoot()})}loadMesh(e){return Le(this,null,function*(){return yield this.mtoonMaterialPlugin.loadMesh(e)})}getMaterialType(e){const t=this.mtoonMaterialPlugin.getMaterialType(e);return t??null}extendMaterialParams(e,t){return Le(this,null,function*(){yield this.materialsHDREmissiveMultiplierPlugin.extendMaterialParams(e,t),yield this.mtoonMaterialPlugin.extendMaterialParams(e,t)})}afterRoot(e){return Le(this,null,function*(){yield this.metaPlugin.afterRoot(e),yield this.humanoidPlugin.afterRoot(e),yield this.expressionPlugin.afterRoot(e),yield this.lookAtPlugin.afterRoot(e),yield this.firstPersonPlugin.afterRoot(e),yield this.springBonePlugin.afterRoot(e),yield this.nodeConstraintPlugin.afterRoot(e),yield this.mtoonMaterialPlugin.afterRoot(e);const t=e.userData.vrmMeta,n=e.userData.vrmHumanoid;if(t&&n){const i=new yi({scene:e.scene,expressionManager:e.userData.vrmExpressionManager,firstPerson:e.userData.vrmFirstPerson,humanoid:n,lookAt:e.userData.vrmLookAt,meta:t,materials:e.userData.vrmMToonMaterials,springBoneManager:e.userData.vrmSpringBoneManager,nodeConstraintManager:e.userData.vrmNodeConstraintManager});e.userData.vrm=i}})}};function vs(e){const t=new Set;return e.traverse(n=>{if(!n.isMesh)return;const i=n;t.add(i)}),t}function qn(e,t,n){if(t.size===1){const s=t.values().next().value;if(s.weight===1)return e[s.index]}const i=new Float32Array(e[0].count*3);let r=0;if(n)r=1;else for(const s of t)r+=s.weight;for(const s of t){const l=e[s.index],a=s.weight/r;for(let u=0;u<l.count;u++)i[u*3+0]+=l.getX(u)*a,i[u*3+1]+=l.getY(u)*a,i[u*3+2]+=l.getZ(u)*a}return new U(i,3)}function Ms(e){var t;const n=vs(e.scene),i=new Map,r=(t=e.expressionManager)==null?void 0:t.expressionMap;if(r!=null)for(const[o,s]of Object.entries(r)){const l=new Set;for(const a of s.binds)if(a instanceof Se){if(a.weight!==0)for(const u of a.primitives){let d=i.get(u);d==null&&(d=new Map,i.set(u,d));let h=d.get(o);h==null&&(h=new Set,d.set(o,h)),h.add(a)}l.add(a)}for(const a of l)s.deleteBind(a)}for(const o of n){const s=i.get(o);if(s==null)continue;const l=o.geometry.morphAttributes;o.geometry.morphAttributes={};const a=o.geometry.clone();o.geometry=a;const u=a.morphTargetsRelative,d=l.position!=null,h=l.normal!=null,c={},p={},f=[];if(d||h){d&&(c.position=[]),h&&(c.normal=[]);let m=0;for(const[g,v]of s)d&&(c.position[m]=qn(l.position,v,u)),h&&(c.normal[m]=qn(l.normal,v,u)),r?.[g].addBind(new Se({index:m,weight:1,primitives:[o]})),p[g]=m,f.push(0),m++}a.morphAttributes=c,o.morphTargetDictionary=p,o.morphTargetInfluences=f}}function Xe(e,t,n){if(e.getComponent)return e.getComponent(t,n);{let i=e.array[t*e.itemSize+n];return e.normalized&&(i=N.denormalize(i,e.array)),i}}function Fi(e,t,n,i){e.setComponent?e.setComponent(t,n,i):(e.normalized&&(i=N.normalize(i,e.array)),e.array[t*e.itemSize+n]=i)}function xs(e){var t;const n=ys(e),i=new Set;for(const h of n)i.has(h.geometry)&&(h.geometry=Ps(h.geometry)),i.add(h.geometry);const r=new Map;for(const h of i){const c=h.getAttribute("skinIndex"),p=(t=r.get(c))!=null?t:new Map;r.set(c,p);const f=h.getAttribute("skinWeight"),m=Rs(c,f);p.set(f,m)}const o=new Map;for(const h of n){const c=Ts(h,r);o.set(h,c)}const s=[];for(const[h,c]of o){let p=!1;for(const f of s)if(ws(c,f.boneInverseMap)){p=!0,f.meshes.add(h);for(const[g,v]of c)f.boneInverseMap.set(g,v);break}p||s.push({boneInverseMap:c,meshes:new Set([h])})}const l=new Map,a=new at,u=new at,d=new at;for(const h of s){const{boneInverseMap:c,meshes:p}=h,f=Array.from(c.keys()),m=Array.from(c.values()),g=new Pt(f,m),v=u.getOrCreate(g);for(const y of p){const R=y.geometry.getAttribute("skinIndex"),T=a.getOrCreate(R),M=y.skeleton.bones,x=M.map(I=>d.getOrCreate(I)).join(","),w=`${T};${v};${x}`;let P=l.get(w);P==null&&(P=R.clone(),Ss(P,M,f),l.set(w,P)),y.geometry.setAttribute("skinIndex",P)}for(const y of p)y.bind(g,new j)}}function ys(e){const t=new Set;return e.traverse(n=>{if(!n.isSkinnedMesh)return;const i=n;t.add(i)}),t}function Rs(e,t){const n=new Set;for(let i=0;i<e.count;i++)for(let r=0;r<e.itemSize;r++){const o=Xe(e,i,r);Xe(t,i,r)!==0&&n.add(o)}return n}function Ts(e,t){const n=new Map,i=e.skeleton,r=e.geometry,o=r.getAttribute("skinIndex"),s=r.getAttribute("skinWeight"),l=t.get(o),a=l?.get(s);if(!a)throw new Error("Unreachable. attributeUsedIndexSetMap does not know the skin index attribute or the skin weight attribute.");for(const u of a)n.set(i.bones[u],i.boneInverses[u]);return n}function ws(e,t){for(const[n,i]of e.entries()){const r=t.get(n);if(r!=null&&!As(i,r))return!1}return!0}function Ss(e,t,n){const i=new Map;for(const o of t)i.set(o,i.size);const r=new Map;for(const[o,s]of n.entries()){const l=i.get(s);r.set(l,o)}for(let o=0;o<e.count;o++)for(let s=0;s<e.itemSize;s++){const l=Xe(e,o,s),a=r.get(l);Fi(e,o,s,a)}e.needsUpdate=!0}function As(e,t,n){if(n=n||1e-4,e.elements.length!=t.elements.length)return!1;for(let i=0,r=e.elements.length;i<r;i++)if(Math.abs(e.elements[i]-t.elements[i])>n)return!1;return!0}var at=class{constructor(){this._objectIndexMap=new Map,this._index=0}get(e){return this._objectIndexMap.get(e)}getOrCreate(e){let t=this._objectIndexMap.get(e);return t==null&&(t=this._index,this._objectIndexMap.set(e,t),this._index++),t}};function Ps(e){var t,n,i,r;const o=new Y;o.name=e.name,o.setIndex(e.index);for(const[s,l]of Object.entries(e.attributes))o.setAttribute(s,l);for(const[s,l]of Object.entries(e.morphAttributes)){const a=s;o.morphAttributes[a]=l.concat()}o.morphTargetsRelative=e.morphTargetsRelative,o.groups=[];for(const s of e.groups)o.addGroup(s.start,s.count,s.materialIndex);return o.boundingSphere=(n=(t=e.boundingSphere)==null?void 0:t.clone())!=null?n:null,o.boundingBox=(r=(i=e.boundingBox)==null?void 0:i.clone())!=null?r:null,o.drawRange.start=e.drawRange.start,o.drawRange.count=e.drawRange.count,o.userData=e.userData,o}function Qn(e){if(Object.values(e).forEach(t=>{t?.isTexture&&t.dispose()}),e.isShaderMaterial){const t=e.uniforms;t&&Object.values(t).forEach(n=>{const i=n.value;i?.isTexture&&i.dispose()})}e.dispose()}function Es(e){const t=e.geometry;t&&t.dispose();const n=e.skeleton;n&&n.dispose();const i=e.material;i&&(Array.isArray(i)?i.forEach(r=>Qn(r)):i&&Qn(i))}function Ls(e){e.traverse(Es)}function bs(e,t){var n,i;console.warn("VRMUtils.removeUnnecessaryJoints: removeUnnecessaryJoints is deprecated. Use combineSkeletons instead. combineSkeletons contributes more to the performance improvement. This function will be removed in the next major version.");const r=(n=t?.experimentalSameBoneCounts)!=null?n:!1,o=[];e.traverse(a=>{a.type==="SkinnedMesh"&&o.push(a)});const s=new Map;let l=0;for(const a of o){const d=a.geometry.getAttribute("skinIndex");if(s.has(d))continue;const h=new Map,c=new Map;for(let p=0;p<d.count;p++)for(let f=0;f<d.itemSize;f++){const m=Xe(d,p,f);let g=h.get(m);g==null&&(g=h.size,h.set(m,g),c.set(g,m)),Fi(d,p,f,g)}d.needsUpdate=!0,s.set(d,c),l=Math.max(l,h.size)}for(const a of o){const d=a.geometry.getAttribute("skinIndex"),h=s.get(d),c=[],p=[],f=r?l:h.size;for(let g=0;g<f;g++){const v=(i=h.get(g))!=null?i:0;c.push(a.skeleton.bones[v]),p.push(a.skeleton.boneInverses[v])}const m=new Pt(c,p);a.bind(m,new j)}}function Is(e,t){const n=e.position.count,i=new Array(n);let r=0;const o=t.array;for(let s=0;s<o.length;s++){const l=o[s];i[l]||(i[l]=!0,r++)}return{isVertexUsed:i,vertexCount:n,verticesUsed:r}}function Ns(e){const t=[],n=[];let i=0;for(let r=0;r<e.length;r++)if(e[r]){const o=i++;t[r]=o,n[o]=r}return{originalIndexNewIndexMap:t,newIndexOriginalIndexMap:n}}function Cs(e,t){var n,i,r,o;t.name=e.name,t.morphTargetsRelative=e.morphTargetsRelative,e.groups.forEach(s=>{t.addGroup(s.start,s.count,s.materialIndex)}),t.boundingBox=(i=(n=e.boundingBox)==null?void 0:n.clone())!=null?i:null,t.boundingSphere=(o=(r=e.boundingSphere)==null?void 0:r.clone())!=null?o:null,t.setDrawRange(e.drawRange.start,e.drawRange.count),t.userData=e.userData}function Os(e,t,n){const i=t.array,r=new i.constructor(i.length);for(let o=0;o<i.length;o++){const s=i[o];r[o]=n[s]}e.setIndex(new U(r,t.itemSize,t.normalized))}function je(e,t,n){const i=e.constructor,r=new i(t.length*n);let o=!0;for(let s=0;s<t.length;s++){const a=t[s]*n,u=s*n;for(let d=0;d<n;d++){const h=e[a+d];r[u+d]=h,o=o&&h===0}}return[r,o]}function Us(e){var t;const n=new Map,i=[];for(const[r,o]of Object.entries(e))if(o.isInterleavedBufferAttribute){const s=o,l=s.data,a=(t=n.get(l))!=null?t:[];n.set(l,a),a.push([r,s])}else{const s=o;i.push([r,s])}return[n,i]}function Vs(e,t,n){const[i,r]=Us(t);for(const[o,s]of i){const l=o.array,{stride:a}=o,[u]=je(l,n,a),d=new Kn(u,a);d.setUsage(o.usage);for(const[h,c]of s){const{itemSize:p,offset:f,normalized:m}=c,g=new ei(d,p,f,m);e.setAttribute(h,g)}}for(const[o,s]of r){const l=s.array,{itemSize:a,normalized:u}=s,[d]=je(l,n,a);e.setAttribute(o,new U(d,a,u))}}function Fs(e){var t;const n=new Map,i=[];for(const[r,o]of Object.entries(e)){const s=r;for(let l=0;l<o.length;l++){const a=o[l];if(a.isInterleavedBufferAttribute){const u=a,d=u.data,h=(t=n.get(d))!=null?t:[];n.set(d,h),h.push([s,l,u])}else{const u=a;i.push([s,l,u])}}}return[n,i]}function Ds(e,t,n){var i,r;let o=!0;const[s,l]=Fs(t),a={};for(const[u,d]of s){const h=u.array,{stride:c}=u,[p,f]=je(h,n,c);o=o&&f;const m=new Kn(p,c);m.setUsage(u.usage);for(const[g,v,y]of d){const{itemSize:R,offset:T,normalized:M}=y,x=new ei(m,R,T,M);(i=a[g])!=null||(a[g]=[]),a[g][v]=x}}for(const[u,d,h]of l){const c=h,p=c.array,{itemSize:f,normalized:m}=c,[g,v]=je(p,n,f);o=o&&v,(r=a[u])!=null||(a[u]=[]),a[u][d]=new U(g,f,m)}e.morphAttributes=o?{}:a}function Bs(e){const t=new Map;e.traverse(n=>{if(!n.isMesh)return;const i=n,r=i.geometry,o=r.index;if(o==null)return;const s=t.get(r);if(s!=null){i.geometry=s;return}const{isVertexUsed:l,vertexCount:a,verticesUsed:u}=Is(r.attributes,o);if(u===a)return;const{originalIndexNewIndexMap:d,newIndexOriginalIndexMap:h}=Ns(l),c=new Y;Cs(r,c),t.set(r,c),Os(c,o,d),Vs(c,r.attributes,h),Ds(c,r.morphAttributes,h),i.geometry=c}),Array.from(t.keys()).forEach(n=>{n.dispose()})}function Hs(e){var t;((t=e.meta)==null?void 0:t.metaVersion)==="0"&&(e.scene.rotation.y=Math.PI)}var re=class{constructor(){}};re.combineMorphs=Ms;re.combineSkeletons=xs;re.deepDispose=Ls;re.removeUnnecessaryJoints=bs;re.removeUnnecessaryVertices=Bs;re.rotateVRM0=Hs;const ya=Object.freeze(Object.defineProperty({__proto__:null,MToonMaterial:Ti,MToonMaterialDebugMode:Ri,MToonMaterialLoaderPlugin:Si,MToonMaterialOutlineWidthMode:Mt,VRM:yi,VRMAimConstraint:Pi,VRMCore:Ft,VRMCoreLoaderPlugin:Mo,VRMExpression:ut,VRMExpressionLoaderPlugin:It,VRMExpressionManager:dt,VRMExpressionMaterialColorBind:ht,VRMExpressionMaterialColorType:ue,VRMExpressionMorphTargetBind:Se,VRMExpressionOverrideType:Qr,VRMExpressionPresetName:ke,VRMExpressionTextureTransformBind:ct,VRMFirstPerson:pt,VRMFirstPersonLoaderPlugin:Ct,VRMFirstPersonMeshAnnotationType:Zr,VRMHumanBoneList:Ce,VRMHumanBoneName:Kr,VRMHumanBoneParentMap:ci,VRMHumanoid:gt,VRMHumanoidHelper:mt,VRMHumanoidLoaderPlugin:Ot,VRMLoaderPlugin:_s,VRMLookAt:xi,VRMLookAtBoneApplier:we,VRMLookAtExpressionApplier:We,VRMLookAtHelper:_i,VRMLookAtLoaderPlugin:Ut,VRMLookAtRangeMap:vt,VRMLookAtTypeName:go,VRMMetaLoaderPlugin:Vt,VRMNodeConstraint:Ge,VRMNodeConstraintHelper:Ve,VRMNodeConstraintLoaderPlugin:Ni,VRMNodeConstraintManager:Ei,VRMRequiredHumanBoneName:gi,VRMRollConstraint:bi,VRMRotationConstraint:Li,VRMSpringBoneCollider:De,VRMSpringBoneColliderHelper:Fe,VRMSpringBoneColliderShape:qe,VRMSpringBoneColliderShapeCapsule:Dt,VRMSpringBoneColliderShapePlane:Bt,VRMSpringBoneColliderShapeSphere:Ht,VRMSpringBoneJoint:Oi,VRMSpringBoneJointHelper:Ci,VRMSpringBoneLoaderPlugin:Vi,VRMSpringBoneManager:Rt,VRMUtils:re},Symbol.toStringTag,{value:"Module"}));var $n=parseInt(Q,10);$n<167&&console.warn(`MToonNodeMaterial requires Three.js r167 or higher (You are using r${$n}). This would not work correctly.`);var ks=L("color","color"),Ws=L("map","texture"),zs=L("normalMap","texture"),Xs=L("normalScale","vec2"),js=L("emissive","color"),Ys=L("emissiveIntensity","float"),Gs=L("emissiveMap","texture"),qs=L("shadeColorFactor","color"),Qs=L("shadingShiftFactor","float"),Zn=L("shadeMultiplyTexture","texture"),$s=L("shadeMultiplyTextureScale","float"),Zs=L("shadingToonyFactor","float"),Js=L("rimLightingMixFactor","float"),Ks=L("rimMultiplyTexture","texture"),ea=L("matcapFactor","color"),ta=L("matcapTexture","texture"),na=L("parametricRimColorFactor","color"),ia=L("parametricRimLiftFactor","float"),ra=L("parametricRimFresnelPowerFactor","float"),oa=L("outlineWidthMultiplyTexture","texture"),sa=L("outlineWidthFactor","float"),Jn=L("outlineColorFactor","color"),aa=L("outlineLightingMixFactor","float"),la=L("uvAnimationMaskTexture","texture"),ua=L("uvAnimationScrollXOffset","float"),da=L("uvAnimationScrollYOffset","float"),ha=L("uvAnimationRotationPhase","float"),Di=class extends Lr{constructor(e){super("vec2"),this.hasMaskTexture=e}setup(){let e=1;this.hasMaskTexture&&(e=ti(la).context({getUV:()=>Tn()}).r);let t=Tn();const n=ha.mul(e),i=br(n),r=Ir(n);t=t.sub(Je(.5,.5)),t=t.mul(Nr(i,r,r.negate(),i)),t=t.add(Je(.5,.5));const o=Je(ua,da).mul(e);return t=t.add(o),t.toVar("AnimatedUV")}},Bi=ne(ie,"vec3").toVar("ShadeColor"),Hi=ne(ie,"float").toVar("ShadingShift"),ki=ne(ie,"float").toVar("ShadingToony"),Tt=ne(ie,"float").toVar("RimLightingMix"),wt=ne(ie,"vec3").toVar("RimMultiply"),St=ne(ie,"vec3").toVar("matcap"),At=ne(ie,"vec3").toVar("ParametricRim"),Qe=e=>parseInt(Q,10)>=168?Xr(e):(void 0)(e),ca=Qe(({a:e,b:t,t:n})=>{const i=n.sub(e),r=t.sub(e);return i.div(r).clamp()}),pa=Qe(({dotNL:e})=>{const n=ee(1).sub(ki);let i=e.add(Hi);return i=ca({a:n.negate(),b:n,t:i}),i=i.mul(1),i}),ma=Qe(({shading:e,lightColor:t})=>{const n=He(Bi,bt,e);return t.mul(lt({diffuseColor:n}))}),Wi=class extends Cr{constructor(){super()}direct({lightDirection:e,lightColor:t,reflectedLight:n}){const i=ni.dot(e).clamp(-1,1),r=pa({dotNL:i});n.directDiffuse.addAssign(ma({shading:r,lightColor:t})),n.directSpecular.addAssign(At.add(St).mul(wt).mul(He(X(0),lt({diffuseColor:t}),Tt)))}indirect(e){const t="context"in e?e.context:e;this.indirectDiffuse(t),this.indirectSpecular(t)}indirectDiffuse(e){const{irradiance:t,reflectedLight:n}=e;n.indirectDiffuse.addAssign(t.mul(lt({diffuseColor:bt})))}indirectSpecular(e){const{reflectedLight:t}=e;t.indirectSpecular.addAssign(At.add(St).mul(wt).mul(He(X(1),X(0),Tt)))}},Re={None:"none",WorldCoordinates:"worldCoordinates",ScreenCoordinates:"screenCoordinates"},fa=Qe(({parametricRimLift:e,parametricRimFresnelPower:t,parametricRimColor:n})=>{const i=jr.normalize(),r=ni.dot(i.negate());return ee(1).sub(r).add(e).clamp().pow(t).mul(n)}),ga=class extends Or{customProgramCacheKey(){let e=super.customProgramCacheKey();return e+=`isOutline:${this.isOutline},`,e}get isMToonNodeMaterial(){return!0}constructor(e={}){super(),e.transparentWithZWrite&&(e.depthWrite=!0),delete e.transparentWithZWrite,delete e.giEqualizationFactor,delete e.v0CompatShade,delete e.debugMode,this.emissiveNode=null,this.lights=!0,this.color=new O(1,1,1),this.map=null,this.emissive=new O(0,0,0),this.emissiveIntensity=1,this.emissiveMap=null,this.normalMap=null,this.normalScale=new ce(1,1),this.shadeColorFactor=new O(0,0,0),this.shadeMultiplyTexture=null,this.shadingShiftFactor=0,this.shadingShiftTexture=null,this.shadingShiftTextureScale=1,this.shadingToonyFactor=.9,this.rimLightingMixFactor=1,this.rimMultiplyTexture=null,this.matcapFactor=new O(1,1,1),this.matcapTexture=null,this.parametricRimColorFactor=new O(0,0,0),this.parametricRimLiftFactor=0,this.parametricRimFresnelPowerFactor=5,this.outlineWidthMode=Re.None,this.outlineWidthMultiplyTexture=null,this.outlineWidthFactor=0,this.outlineColorFactor=new O(0,0,0),this.outlineLightingMixFactor=1,this.uvAnimationScrollXSpeedFactor=0,this.uvAnimationScrollYSpeedFactor=0,this.uvAnimationRotationSpeedFactor=0,this.uvAnimationMaskTexture=null,this.shadeColorNode=null,this.shadingShiftNode=null,this.shadingToonyNode=null,this.rimLightingMixNode=null,this.rimMultiplyNode=null,this.matcapNode=null,this.parametricRimColorNode=null,this.parametricRimLiftNode=null,this.parametricRimFresnelPowerNode=null,this.uvAnimationScrollXOffset=0,this.uvAnimationScrollYOffset=0,this.uvAnimationRotationPhase=0,this.isOutline=!1,this._animatedUVNode=null,this.setValues(e)}setupLightingModel(){return new Wi}setup(e){var t;this._animatedUVNode=new Di((t=this.uvAnimationMaskTexture&&this.uvAnimationMaskTexture.isTexture===!0)!=null?t:!1),super.setup(e)}setupDiffuseColor(e){let t=null;if(this.colorNode==null){if(t=ks,this.map&&this.map.isTexture===!0){const n=Ws.context({getUV:()=>this._animatedUVNode});t=t.mul(n)}this.colorNode=t}this.vertexColors===!0&&e.geometry.hasAttribute("color")&&(console.warn("MToonNodeMaterial: MToon ignores vertex colors. Consider using a model without vertex colors instead."),this.vertexColors=!1),super.setupDiffuseColor(e),parseInt(Q,10)<166&&this.transparent===!1&&this.blending===Ur&&this.alphaToCoverage===!1&&bt.a.assign(1),this.colorNode===t&&(this.colorNode=null)}setupVariants(){Bi.assign(this._setupShadeColorNode()),Hi.assign(this._setupShadingShiftNode()),ki.assign(this._setupShadingToonyNode()),Tt.assign(this._setupRimLightingMixNode()),wt.assign(this._setupRimMultiplyNode()),St.assign(this._setupMatcapNode()),At.assign(this._setupParametricRimNode())}setupNormal(e){const t=this.normalNode;if(this.normalNode==null){if(this.normalNode=Vr,this.normalMap&&this.normalMap.isTexture===!0){const i=zs.context({getUV:()=>this._animatedUVNode});this.normalNode=Fr(i,Xs)}this.isOutline&&(this.normalNode=this.normalNode.negate())}if(parseInt(Q,10)>=168){const i=this.normalNode;return this.normalNode=t,i}else{super.setupNormal(e),this.normalNode=t;return}}setupLighting(e){let t=null;if(this.emissiveNode==null){if(t=js.mul(Ys),this.emissiveMap&&this.emissiveMap.isTexture===!0){const i=Gs.context({getUV:()=>this._animatedUVNode});t=t.mul(i)}this.emissiveNode=t}const n=super.setupLighting(e);return this.emissiveNode===t&&(this.emissiveNode=null),n}setupOutput(e,t){return this.isOutline&&this.outlineWidthMode!==Re.None&&(t=ti(He(Jn,t.xyz.mul(Jn),aa),t.w)),super.setupOutput(e,t)}setupPosition(e){var t,n;const i=this.positionNode;if(this.isOutline&&this.outlineWidthMode!==Re.None){(t=this.positionNode)!=null||(this.positionNode=Ke);const o=Dr.normalize();let s=sa;if(this.outlineWidthMultiplyTexture&&this.outlineWidthMultiplyTexture.isTexture===!0){const u=oa.context({getUV:()=>this._animatedUVNode});s=s.mul(u)}const l=Br(Hr.mul(o)),a=s.mul(l).mul(o);if(this.outlineWidthMode===Re.WorldCoordinates)this.positionNode=this.positionNode.add(a);else if(this.outlineWidthMode===Re.ScreenCoordinates){const u=kr.element(1).element(1),d=Wr.mul(Ke);this.positionNode=this.positionNode.add(a.div(u).mul(d.z.negate()))}(n=this.positionNode)!=null||(this.positionNode=Ke)}const r=super.setupPosition(e);return r.z.add(r.w.mul(1e-6)),this.positionNode=i,r}copy(e){var t,n,i,r,o,s,l,a,u,d,h,c,p,f,m,g,v,y,R;return this.color.copy(e.color),this.map=(t=e.map)!=null?t:null,this.emissive.copy(e.emissive),this.emissiveIntensity=e.emissiveIntensity,this.emissiveMap=(n=e.emissiveMap)!=null?n:null,this.normalMap=(i=e.normalMap)!=null?i:null,this.normalScale.copy(e.normalScale),this.shadeColorFactor.copy(e.shadeColorFactor),this.shadeMultiplyTexture=(r=e.shadeMultiplyTexture)!=null?r:null,this.shadingShiftFactor=e.shadingShiftFactor,this.shadingShiftTexture=(o=e.shadingShiftTexture)!=null?o:null,this.shadingShiftTextureScale=e.shadingShiftTextureScale,this.shadingToonyFactor=e.shadingToonyFactor,this.rimLightingMixFactor=e.rimLightingMixFactor,this.rimMultiplyTexture=(s=e.rimMultiplyTexture)!=null?s:null,this.matcapFactor.copy(e.matcapFactor),this.matcapTexture=(l=e.matcapTexture)!=null?l:null,this.parametricRimColorFactor.copy(e.parametricRimColorFactor),this.parametricRimLiftFactor=e.parametricRimLiftFactor,this.parametricRimFresnelPowerFactor=e.parametricRimFresnelPowerFactor,this.outlineWidthMode=e.outlineWidthMode,this.outlineWidthMultiplyTexture=(a=e.outlineWidthMultiplyTexture)!=null?a:null,this.outlineWidthFactor=e.outlineWidthFactor,this.outlineColorFactor.copy(e.outlineColorFactor),this.outlineLightingMixFactor=e.outlineLightingMixFactor,this.uvAnimationScrollXSpeedFactor=e.uvAnimationScrollXSpeedFactor,this.uvAnimationScrollYSpeedFactor=e.uvAnimationScrollYSpeedFactor,this.uvAnimationRotationSpeedFactor=e.uvAnimationRotationSpeedFactor,this.uvAnimationMaskTexture=(u=e.uvAnimationMaskTexture)!=null?u:null,this.shadeColorNode=(d=e.shadeColorNode)!=null?d:null,this.shadingShiftNode=(h=e.shadingShiftNode)!=null?h:null,this.shadingToonyNode=(c=e.shadingToonyNode)!=null?c:null,this.rimLightingMixNode=(p=e.rimLightingMixNode)!=null?p:null,this.rimMultiplyNode=(f=e.rimMultiplyNode)!=null?f:null,this.matcapNode=(m=e.matcapNode)!=null?m:null,this.parametricRimColorNode=(g=e.parametricRimColorNode)!=null?g:null,this.parametricRimLiftNode=(v=e.parametricRimLiftNode)!=null?v:null,this.parametricRimFresnelPowerNode=(y=e.parametricRimFresnelPowerNode)!=null?y:null,this.isOutline=(R=e.isOutline)!=null?R:null,super.copy(e)}update(e){this.uvAnimationScrollXOffset+=e*this.uvAnimationScrollXSpeedFactor,this.uvAnimationScrollYOffset+=e*this.uvAnimationScrollYSpeedFactor,this.uvAnimationRotationPhase+=e*this.uvAnimationRotationSpeedFactor}_setupShadeColorNode(){if(this.shadeColorNode!=null)return X(this.shadeColorNode);let e=qs;if(this.shadeMultiplyTexture&&this.shadeMultiplyTexture.isTexture===!0){const t=Zn.context({getUV:()=>this._animatedUVNode});e=e.mul(t)}return e}_setupShadingShiftNode(){if(this.shadingShiftNode!=null)return ee(this.shadingShiftNode);let e=Qs;if(this.shadingShiftTexture&&this.shadingShiftTexture.isTexture===!0){const t=Zn.context({getUV:()=>this._animatedUVNode});e=e.add(t.mul($s))}return e}_setupShadingToonyNode(){return this.shadingToonyNode!=null?ee(this.shadingToonyNode):Zs}_setupRimLightingMixNode(){return this.rimLightingMixNode!=null?ee(this.rimLightingMixNode):Js}_setupRimMultiplyNode(){return this.rimMultiplyNode!=null?X(this.rimMultiplyNode):this.rimMultiplyTexture&&this.rimMultiplyTexture.isTexture===!0?Ks.context({getUV:()=>this._animatedUVNode}):X(1)}_setupMatcapNode(){return this.matcapNode!=null?X(this.matcapNode):this.matcapTexture&&this.matcapTexture.isTexture===!0?ta.context({getUV:()=>zr.mul(1,-1).add(0,1)}).mul(ea):X(0)}_setupParametricRimNode(){const e=this.parametricRimColorNode!=null?X(this.parametricRimColorNode):na,t=this.parametricRimLiftNode!=null?ee(this.parametricRimLiftNode):ia,n=this.parametricRimFresnelPowerNode!=null?ee(this.parametricRimFresnelPowerNode):ra;return fa({parametricRimLift:t,parametricRimFresnelPower:n,parametricRimColor:e})}};const Ra=Object.freeze(Object.defineProperty({__proto__:null,MToonAnimatedUVNode:Di,MToonLightingModel:Wi,MToonNodeMaterial:ga},Symbol.toStringTag,{value:"Module"}));export{Ra as i,ya as t};
