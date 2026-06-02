import{S as bi,T as Ii,U as Oi,a as ue,M as k,C as V,b as Ci,B as Ui,V as g,Q as E,O as Ae,c as me,d as Ni,G as Dt,e as et,f as z,g as re,A as Vi,E as tt,h as I,i as Bt,D as Ft,j as Ht,L as Ce,k as nt,l as C,m as Di,n as j,o as Bi,R as Pe,I as Fi,p as Tn,q as Sn}from"./three.module-D-RgI2d8.js";var xe=(e,t,n)=>new Promise((i,r)=>{var o=a=>{try{l(n.next(a))}catch(u){r(u)}},s=a=>{try{l(n.throw(a))}catch(u){r(u)}},l=a=>a.done?i(a.value):Promise.resolve(a.value).then(o,s);l((n=n.apply(e,t)).next())}),S=(e,t,n)=>new Promise((i,r)=>{var o=a=>{try{l(n.next(a))}catch(u){r(u)}},s=a=>{try{l(n.throw(a))}catch(u){r(u)}},l=a=>a.done?i(a.value):Promise.resolve(a.value).then(o,s);l((n=n.apply(e,t)).next())}),kt=class extends Ae{constructor(e){super(),this.weight=0,this.isBinary=!1,this.overrideBlink="none",this.overrideLookAt="none",this.overrideMouth="none",this._binds=[],this.name=`VRMExpression_${e}`,this.expressionName=e,this.type="VRMExpression",this.visible=!1}get binds(){return this._binds}get overrideBlinkAmount(){return this.overrideBlink==="block"?0<this.outputWeight?1:0:this.overrideBlink==="blend"?this.outputWeight:0}get overrideLookAtAmount(){return this.overrideLookAt==="block"?0<this.outputWeight?1:0:this.overrideLookAt==="blend"?this.outputWeight:0}get overrideMouthAmount(){return this.overrideMouth==="block"?0<this.outputWeight?1:0:this.overrideMouth==="blend"?this.outputWeight:0}get outputWeight(){return this.isBinary?this.weight>.5?1:0:this.weight}addBind(e){this._binds.push(e)}deleteBind(e){const t=this._binds.indexOf(e);t>=0&&this._binds.splice(t,1)}applyWeight(e){var t;let n=this.outputWeight;n*=(t=e?.multiplier)!=null?t:1,this.isBinary&&n<1&&(n=0),this._binds.forEach(i=>i.applyWeight(n))}clearAppliedWeight(){this._binds.forEach(e=>e.clearAppliedWeight())}};function En(e,t,n){var i,r;const o=e.parser.json,s=(i=o.nodes)==null?void 0:i[t];if(s==null)return console.warn(`extractPrimitivesInternal: Attempt to use nodes[${t}] of glTF but the node doesn't exist`),null;const l=s.mesh;if(l==null)return null;const a=(r=o.meshes)==null?void 0:r[l];if(a==null)return console.warn(`extractPrimitivesInternal: Attempt to use meshes[${l}] of glTF but the mesh doesn't exist`),null;const u=a.primitives.length,h=[];return n.traverse(d=>{h.length<u&&d.isMesh&&h.push(d)}),h}function Wt(e,t){return S(this,null,function*(){const n=yield e.parser.getDependency("node",t);return En(e,t,n)})}function zt(e){return S(this,null,function*(){const t=yield e.parser.getDependencies("node"),n=new Map;return t.forEach((i,r)=>{const o=En(e,r,i);o!=null&&n.set(r,o)}),n})}var qe={Aa:"aa",Ih:"ih",Ou:"ou",Ee:"ee",Oh:"oh",Blink:"blink",Happy:"happy",Angry:"angry",Sad:"sad",Relaxed:"relaxed",LookUp:"lookUp",Surprised:"surprised",LookDown:"lookDown",LookLeft:"lookLeft",LookRight:"lookRight",BlinkLeft:"blinkLeft",BlinkRight:"blinkRight",Neutral:"neutral"};function An(e){return Math.max(Math.min(e,1),0)}var jt=class Pn{constructor(){this.blinkExpressionNames=["blink","blinkLeft","blinkRight"],this.lookAtExpressionNames=["lookLeft","lookRight","lookUp","lookDown"],this.mouthExpressionNames=["aa","ee","ih","oh","ou"],this._expressions=[],this._expressionMap={}}get expressions(){return this._expressions.concat()}get expressionMap(){return Object.assign({},this._expressionMap)}get presetExpressionMap(){const t={},n=new Set(Object.values(qe));return Object.entries(this._expressionMap).forEach(([i,r])=>{n.has(i)&&(t[i]=r)}),t}get customExpressionMap(){const t={},n=new Set(Object.values(qe));return Object.entries(this._expressionMap).forEach(([i,r])=>{n.has(i)||(t[i]=r)}),t}copy(t){return this._expressions.concat().forEach(i=>{this.unregisterExpression(i)}),t._expressions.forEach(i=>{this.registerExpression(i)}),this.blinkExpressionNames=t.blinkExpressionNames.concat(),this.lookAtExpressionNames=t.lookAtExpressionNames.concat(),this.mouthExpressionNames=t.mouthExpressionNames.concat(),this}clone(){return new Pn().copy(this)}getExpression(t){var n;return(n=this._expressionMap[t])!=null?n:null}registerExpression(t){this._expressions.push(t),this._expressionMap[t.expressionName]=t}unregisterExpression(t){const n=this._expressions.indexOf(t);n===-1&&console.warn("VRMExpressionManager: The specified expressions is not registered"),this._expressions.splice(n,1),delete this._expressionMap[t.expressionName]}getValue(t){var n;const i=this.getExpression(t);return(n=i?.weight)!=null?n:null}setValue(t,n){const i=this.getExpression(t);i&&(i.weight=An(n))}resetValues(){this._expressions.forEach(t=>{t.weight=0})}getExpressionTrackName(t){const n=this.getExpression(t);return n?`${n.name}.weight`:null}update(){const t=this._calculateWeightMultipliers();this._expressions.forEach(n=>{n.clearAppliedWeight()}),this._expressions.forEach(n=>{let i=1;const r=n.expressionName;this.blinkExpressionNames.indexOf(r)!==-1&&(i*=t.blink),this.lookAtExpressionNames.indexOf(r)!==-1&&(i*=t.lookAt),this.mouthExpressionNames.indexOf(r)!==-1&&(i*=t.mouth),n.applyWeight({multiplier:i})})}_calculateWeightMultipliers(){let t=1,n=1,i=1;return this._expressions.forEach(r=>{t-=r.overrideBlinkAmount,n-=r.overrideLookAtAmount,i-=r.overrideMouthAmount}),t=Math.max(0,t),n=Math.max(0,n),i=Math.max(0,i),{blink:t,lookAt:n,mouth:i}}},de={Color:"color",EmissionColor:"emissionColor",ShadeColor:"shadeColor",MatcapColor:"matcapColor",RimColor:"rimColor",OutlineColor:"outlineColor"},Hi={_Color:de.Color,_EmissionColor:de.EmissionColor,_ShadeColor:de.ShadeColor,_RimColor:de.RimColor,_OutlineColor:de.OutlineColor},ki=new V,Ln=class bn{constructor({material:t,type:n,targetValue:i,targetAlpha:r}){this.material=t,this.type=n,this.targetValue=i,this.targetAlpha=r??1;const o=this._initColorBindState(),s=this._initAlphaBindState();this._state={color:o,alpha:s}}applyWeight(t){const{color:n,alpha:i}=this._state;if(n!=null){const{propertyName:r,deltaValue:o}=n,s=this.material[r];s?.add(ki.copy(o).multiplyScalar(t))}if(i!=null){const{propertyName:r,deltaValue:o}=i;this.material[r]!=null&&(this.material[r]+=o*t)}}clearAppliedWeight(){const{color:t,alpha:n}=this._state;if(t!=null){const{propertyName:i,initialValue:r}=t,o=this.material[i];o?.copy(r)}if(n!=null){const{propertyName:i,initialValue:r}=n;this.material[i]!=null&&(this.material[i]=r)}}_initColorBindState(){var t,n,i;const{material:r,type:o,targetValue:s}=this,l=this._getPropertyNameMap(),a=(n=(t=l?.[o])==null?void 0:t[0])!=null?n:null;if(a==null)return console.warn(`Tried to add a material color bind to the material ${(i=r.name)!=null?i:"(no name)"}, the type ${o} but the material or the type is not supported.`),null;const h=r[a].clone(),d=new V(s.r-h.r,s.g-h.g,s.b-h.b);return{propertyName:a,initialValue:h,deltaValue:d}}_initAlphaBindState(){var t,n,i;const{material:r,type:o,targetAlpha:s}=this,l=this._getPropertyNameMap(),a=(n=(t=l?.[o])==null?void 0:t[1])!=null?n:null;if(a==null&&s!==1)return console.warn(`Tried to add a material alpha bind to the material ${(i=r.name)!=null?i:"(no name)"}, the type ${o} but the material or the type does not support alpha.`),null;if(a==null)return null;const u=r[a],h=s-u;return{propertyName:a,initialValue:u,deltaValue:h}}_getPropertyNameMap(){var t,n;return(n=(t=Object.entries(bn._propertyNameMapMap).find(([i])=>this.material[i]===!0))==null?void 0:t[1])!=null?n:null}};Ln._propertyNameMapMap={isMeshStandardMaterial:{color:["color","opacity"],emissionColor:["emissive",null]},isMeshBasicMaterial:{color:["color","opacity"]},isMToonMaterial:{color:["color","opacity"],emissionColor:["emissive",null],outlineColor:["outlineColorFactor",null],matcapColor:["matcapFactor",null],rimColor:["parametricRimColorFactor",null],shadeColor:["shadeColorFactor",null]}};var Xt=Ln,Le=class{constructor({primitives:e,index:t,weight:n}){this.primitives=e,this.index=t,this.weight=n}applyWeight(e){this.primitives.forEach(t=>{var n;((n=t.morphTargetInfluences)==null?void 0:n[this.index])!=null&&(t.morphTargetInfluences[this.index]+=this.weight*e)})}clearAppliedWeight(){this.primitives.forEach(e=>{var t;((t=e.morphTargetInfluences)==null?void 0:t[this.index])!=null&&(e.morphTargetInfluences[this.index]=0)})}},Gt=new me,In=class On{constructor({material:t,scale:n,offset:i}){var r,o;this.material=t,this.scale=n,this.offset=i;const s=(r=Object.entries(On._propertyNamesMap).find(([l])=>t[l]===!0))==null?void 0:r[1];s==null?(console.warn(`Tried to add a texture transform bind to the material ${(o=t.name)!=null?o:"(no name)"} but the material is not supported.`),this._properties=[]):(this._properties=[],s.forEach(l=>{var a;const u=(a=t[l])==null?void 0:a.clone();if(!u)return null;t[l]=u;const h=u.offset.clone(),d=u.repeat.clone(),c=i.clone().sub(h),p=n.clone().sub(d);this._properties.push({name:l,initialOffset:h,deltaOffset:c,initialScale:d,deltaScale:p})}))}applyWeight(t){this._properties.forEach(n=>{const i=this.material[n.name];i!==void 0&&(i.offset.add(Gt.copy(n.deltaOffset).multiplyScalar(t)),i.repeat.add(Gt.copy(n.deltaScale).multiplyScalar(t)))})}clearAppliedWeight(){this._properties.forEach(t=>{const n=this.material[t.name];n!==void 0&&(n.offset.copy(t.initialOffset),n.repeat.copy(t.initialScale))})}};In._propertyNamesMap={isMeshStandardMaterial:["map","emissiveMap","bumpMap","normalMap","displacementMap","roughnessMap","metalnessMap","alphaMap"],isMeshBasicMaterial:["map","specularMap","alphaMap"],isMToonMaterial:["map","normalMap","emissiveMap","shadeMultiplyTexture","rimMultiplyTexture","outlineWidthMultiplyTexture","uvAnimationMaskTexture"]};var Yt=In,Wi=new Set(["1.0","1.0-beta"]),Cn=class Un{get name(){return"VRMExpressionLoaderPlugin"}constructor(t){this.parser=t}afterRoot(t){return S(this,null,function*(){t.userData.vrmExpressionManager=yield this._import(t)})}_import(t){return S(this,null,function*(){const n=yield this._v1Import(t);if(n)return n;const i=yield this._v0Import(t);return i||null})}_v1Import(t){return S(this,null,function*(){var n,i;const r=this.parser.json;if(!(((n=r.extensionsUsed)==null?void 0:n.indexOf("VRMC_vrm"))!==-1))return null;const s=(i=r.extensions)==null?void 0:i.VRMC_vrm;if(!s)return null;const l=s.specVersion;if(!Wi.has(l))return console.warn(`VRMExpressionLoaderPlugin: Unknown VRMC_vrm specVersion "${l}"`),null;const a=s.expressions;if(!a)return null;const u=new Set(Object.values(qe)),h=new Map;a.preset!=null&&Object.entries(a.preset).forEach(([c,p])=>{if(p!=null){if(!u.has(c)){console.warn(`VRMExpressionLoaderPlugin: Unknown preset name "${c}" detected. Ignoring the expression`);return}h.set(c,p)}}),a.custom!=null&&Object.entries(a.custom).forEach(([c,p])=>{if(u.has(c)){console.warn(`VRMExpressionLoaderPlugin: Custom expression cannot have preset name "${c}". Ignoring the expression`);return}h.set(c,p)});const d=new jt;return yield Promise.all(Array.from(h.entries()).map(c=>S(this,[c],function*([p,m]){var f,_,v,R,w,y,M;const x=new kt(p);if(t.scene.add(x),x.isBinary=(f=m.isBinary)!=null?f:!1,x.overrideBlink=(_=m.overrideBlink)!=null?_:"none",x.overrideLookAt=(v=m.overrideLookAt)!=null?v:"none",x.overrideMouth=(R=m.overrideMouth)!=null?R:"none",(w=m.morphTargetBinds)==null||w.forEach(T=>S(this,null,function*(){var A;if(T.node===void 0||T.index===void 0)return;const b=yield Wt(t,T.node),P=T.index;if(!b.every(L=>Array.isArray(L.morphTargetInfluences)&&P<L.morphTargetInfluences.length)){console.warn(`VRMExpressionLoaderPlugin: ${m.name} attempts to index morph #${P} but not found.`);return}x.addBind(new Le({primitives:b,index:P,weight:(A=T.weight)!=null?A:1}))})),m.materialColorBinds||m.textureTransformBinds){const T=[];t.scene.traverse(A=>{const b=A.material;b&&(Array.isArray(b)?T.push(...b):T.push(b))}),(y=m.materialColorBinds)==null||y.forEach(A=>S(this,null,function*(){T.filter(P=>{var L;const O=(L=this.parser.associations.get(P))==null?void 0:L.materials;return A.material===O}).forEach(P=>{x.addBind(new Xt({material:P,type:A.type,targetValue:new V().fromArray(A.targetValue),targetAlpha:A.targetValue[3]}))})})),(M=m.textureTransformBinds)==null||M.forEach(A=>S(this,null,function*(){T.filter(P=>{var L;const O=(L=this.parser.associations.get(P))==null?void 0:L.materials;return A.material===O}).forEach(P=>{var L,O;x.addBind(new Yt({material:P,offset:new me().fromArray((L=A.offset)!=null?L:[0,0]),scale:new me().fromArray((O=A.scale)!=null?O:[1,1])}))})}))}d.registerExpression(x)}))),d})}_v0Import(t){return S(this,null,function*(){var n;const i=this.parser.json,r=(n=i.extensions)==null?void 0:n.VRM;if(!r)return null;const o=r.blendShapeMaster;if(!o)return null;const s=new jt,l=o.blendShapeGroups;if(!l)return s;const a=new Set;return yield Promise.all(l.map(u=>S(this,null,function*(){var h;const d=u.presetName,c=d!=null&&Un.v0v1PresetNameMap[d]||null,p=c??u.name;if(p==null){console.warn("VRMExpressionLoaderPlugin: One of custom expressions has no name. Ignoring the expression");return}if(a.has(p)){console.warn(`VRMExpressionLoaderPlugin: An expression preset ${d} has duplicated entries. Ignoring the expression`);return}a.add(p);const m=new kt(p);t.scene.add(m),m.isBinary=(h=u.isBinary)!=null?h:!1,u.binds&&u.binds.forEach(_=>S(this,null,function*(){var v;if(_.mesh===void 0||_.index===void 0)return;const R=[];(v=i.nodes)==null||v.forEach((y,M)=>{y.mesh===_.mesh&&R.push(M)});const w=_.index;yield Promise.all(R.map(y=>S(this,null,function*(){var M;const x=yield Wt(t,y);if(!x.every(T=>Array.isArray(T.morphTargetInfluences)&&w<T.morphTargetInfluences.length)){console.warn(`VRMExpressionLoaderPlugin: ${u.name} attempts to index ${w}th morph but not found.`);return}m.addBind(new Le({primitives:x,index:w,weight:.01*((M=_.weight)!=null?M:100)}))})))}));const f=u.materialValues;f&&f.length!==0&&f.forEach(_=>{if(_.materialName===void 0||_.propertyName===void 0||_.targetValue===void 0)return;const v=[];t.scene.traverse(w=>{if(w.material){const y=w.material;Array.isArray(y)?v.push(...y.filter(M=>(M.name===_.materialName||M.name===_.materialName+" (Outline)")&&v.indexOf(M)===-1)):y.name===_.materialName&&v.indexOf(y)===-1&&v.push(y)}});const R=_.propertyName;v.forEach(w=>{if(R==="_MainTex_ST"){const M=new me(_.targetValue[0],_.targetValue[1]),x=new me(_.targetValue[2],_.targetValue[3]);x.y=1-x.y-M.y,m.addBind(new Yt({material:w,scale:M,offset:x}));return}const y=Hi[R];if(y){m.addBind(new Xt({material:w,type:y,targetValue:new V().fromArray(_.targetValue),targetAlpha:_.targetValue[3]}));return}console.warn(R+" is not supported")})}),s.registerExpression(m)}))),s})}};Cn.v0v1PresetNameMap={a:"aa",e:"ee",i:"ih",o:"oh",u:"ou",blink:"blink",joy:"happy",angry:"angry",sorrow:"sad",fun:"relaxed",lookup:"lookUp",lookdown:"lookDown",lookleft:"lookLeft",lookright:"lookRight",blink_l:"blinkLeft",blink_r:"blinkRight",neutral:"neutral"};var Nn=Cn,Qo={None:"none",Block:"block",Blend:"blend"},it=class ne{constructor(t,n){this._firstPersonOnlyLayer=ne.DEFAULT_FIRSTPERSON_ONLY_LAYER,this._thirdPersonOnlyLayer=ne.DEFAULT_THIRDPERSON_ONLY_LAYER,this._initializedLayers=!1,this.humanoid=t,this.meshAnnotations=n}copy(t){if(this.humanoid!==t.humanoid)throw new Error("VRMFirstPerson: humanoid must be same in order to copy");return this.meshAnnotations=t.meshAnnotations.map(n=>({meshes:n.meshes.concat(),type:n.type})),this}clone(){return new ne(this.humanoid,this.meshAnnotations).copy(this)}get firstPersonOnlyLayer(){return this._firstPersonOnlyLayer}get thirdPersonOnlyLayer(){return this._thirdPersonOnlyLayer}setup({firstPersonOnlyLayer:t=ne.DEFAULT_FIRSTPERSON_ONLY_LAYER,thirdPersonOnlyLayer:n=ne.DEFAULT_THIRDPERSON_ONLY_LAYER}={}){this._initializedLayers||(this._firstPersonOnlyLayer=t,this._thirdPersonOnlyLayer=n,this.meshAnnotations.forEach(i=>{i.meshes.forEach(r=>{i.type==="firstPersonOnly"?(r.layers.set(this._firstPersonOnlyLayer),r.traverse(o=>o.layers.set(this._firstPersonOnlyLayer))):i.type==="thirdPersonOnly"?(r.layers.set(this._thirdPersonOnlyLayer),r.traverse(o=>o.layers.set(this._thirdPersonOnlyLayer))):i.type==="auto"&&this._createHeadlessModel(r)})}),this._initializedLayers=!0)}_excludeTriangles(t,n,i,r){let o=0;if(n!=null&&n.length>0)for(let s=0;s<t.length;s+=3){const l=t[s],a=t[s+1],u=t[s+2],h=n[l],d=i[l];if(h[0]>0&&r.includes(d[0])||h[1]>0&&r.includes(d[1])||h[2]>0&&r.includes(d[2])||h[3]>0&&r.includes(d[3]))continue;const c=n[a],p=i[a];if(c[0]>0&&r.includes(p[0])||c[1]>0&&r.includes(p[1])||c[2]>0&&r.includes(p[2])||c[3]>0&&r.includes(p[3]))continue;const m=n[u],f=i[u];m[0]>0&&r.includes(f[0])||m[1]>0&&r.includes(f[1])||m[2]>0&&r.includes(f[2])||m[3]>0&&r.includes(f[3])||(t[o++]=l,t[o++]=a,t[o++]=u)}return o}_createErasedMesh(t,n){const i=new Ni(t.geometry.clone(),t.material);i.name=`${t.name}(erase)`,i.frustumCulled=t.frustumCulled,i.layers.set(this._firstPersonOnlyLayer);const r=i.geometry,o=r.getAttribute("skinIndex"),s=o instanceof Dt?[]:o.array,l=[];for(let f=0;f<s.length;f+=4)l.push([s[f],s[f+1],s[f+2],s[f+3]]);const a=r.getAttribute("skinWeight"),u=a instanceof Dt?[]:a.array,h=[];for(let f=0;f<u.length;f+=4)h.push([u[f],u[f+1],u[f+2],u[f+3]]);const d=r.getIndex();if(!d)throw new Error("The geometry doesn't have an index buffer");const c=Array.from(d.array),p=this._excludeTriangles(c,h,l,n),m=[];for(let f=0;f<p;f++)m[f]=c[f];return r.setIndex(m),t.onBeforeRender&&(i.onBeforeRender=t.onBeforeRender),i.bind(new et(t.skeleton.bones,t.skeleton.boneInverses),new z),i}_createHeadlessModelForSkinnedMesh(t,n){const i=[];if(n.skeleton.bones.forEach((o,s)=>{this._isEraseTarget(o)&&i.push(s)}),!i.length){n.layers.enable(this._thirdPersonOnlyLayer),n.layers.enable(this._firstPersonOnlyLayer);return}n.layers.set(this._thirdPersonOnlyLayer);const r=this._createErasedMesh(n,i);t.add(r)}_createHeadlessModel(t){if(t.type==="Group")if(t.layers.set(this._thirdPersonOnlyLayer),this._isEraseTarget(t))t.traverse(n=>n.layers.set(this._thirdPersonOnlyLayer));else{const n=new re;n.name=`_headless_${t.name}`,n.layers.set(this._firstPersonOnlyLayer),t.parent.add(n),t.children.filter(i=>i.type==="SkinnedMesh").forEach(i=>{const r=i;this._createHeadlessModelForSkinnedMesh(n,r)})}else if(t.type==="SkinnedMesh"){const n=t;this._createHeadlessModelForSkinnedMesh(t.parent,n)}else this._isEraseTarget(t)&&(t.layers.set(this._thirdPersonOnlyLayer),t.traverse(n=>n.layers.set(this._thirdPersonOnlyLayer)))}_isEraseTarget(t){return t===this.humanoid.getRawBoneNode("head")?!0:t.parent?this._isEraseTarget(t.parent):!1}};it.DEFAULT_FIRSTPERSON_ONLY_LAYER=9;it.DEFAULT_THIRDPERSON_ONLY_LAYER=10;var qt=it,zi=new Set(["1.0","1.0-beta"]),Vn=class{get name(){return"VRMFirstPersonLoaderPlugin"}constructor(e){this.parser=e}afterRoot(e){return S(this,null,function*(){const t=e.userData.vrmHumanoid;if(t!==null){if(t===void 0)throw new Error("VRMFirstPersonLoaderPlugin: vrmHumanoid is undefined. VRMHumanoidLoaderPlugin have to be used first");e.userData.vrmFirstPerson=yield this._import(e,t)}})}_import(e,t){return S(this,null,function*(){if(t==null)return null;const n=yield this._v1Import(e,t);if(n)return n;const i=yield this._v0Import(e,t);return i||null})}_v1Import(e,t){return S(this,null,function*(){var n,i;const r=this.parser.json;if(!(((n=r.extensionsUsed)==null?void 0:n.indexOf("VRMC_vrm"))!==-1))return null;const s=(i=r.extensions)==null?void 0:i.VRMC_vrm;if(!s)return null;const l=s.specVersion;if(!zi.has(l))return console.warn(`VRMFirstPersonLoaderPlugin: Unknown VRMC_vrm specVersion "${l}"`),null;const a=s.firstPerson,u=[],h=yield zt(e);return Array.from(h.entries()).forEach(([d,c])=>{var p,m;const f=(p=a?.meshAnnotations)==null?void 0:p.find(_=>_.node===d);u.push({meshes:c,type:(m=f?.type)!=null?m:"auto"})}),new qt(t,u)})}_v0Import(e,t){return S(this,null,function*(){var n;const i=this.parser.json,r=(n=i.extensions)==null?void 0:n.VRM;if(!r)return null;const o=r.firstPerson;if(!o)return null;const s=[],l=yield zt(e);return Array.from(l.entries()).forEach(([a,u])=>{const h=i.nodes[a],d=o.meshAnnotations?o.meshAnnotations.find(c=>c.mesh===h.mesh):void 0;s.push({meshes:u,type:this._convertV0FlagToV1Type(d?.firstPersonFlag)})}),new qt(t,s)})}_convertV0FlagToV1Type(e){return e==="FirstPersonOnly"?"firstPersonOnly":e==="ThirdPersonOnly"?"thirdPersonOnly":e==="Both"?"both":"auto"}},$o={Auto:"auto",Both:"both",ThirdPersonOnly:"thirdPersonOnly",FirstPersonOnly:"firstPersonOnly"},Qt=new g,$t=new g,ji=new E,Zt=class extends re{constructor(e){super(),this.vrmHumanoid=e,this._boneAxesMap=new Map,Object.values(e.humanBones).forEach(t=>{const n=new Vi(1);n.matrixAutoUpdate=!1,n.material.depthTest=!1,n.material.depthWrite=!1,this.add(n),this._boneAxesMap.set(t,n)})}dispose(){Array.from(this._boneAxesMap.values()).forEach(e=>{e.geometry.dispose(),e.material.dispose()})}updateMatrixWorld(e){Array.from(this._boneAxesMap.entries()).forEach(([t,n])=>{t.node.updateWorldMatrix(!0,!1),t.node.matrixWorld.decompose(Qt,ji,$t);const i=Qt.set(.1,.1,.1).divide($t);n.matrix.copy(t.node.matrixWorld).scale(i)}),super.updateMatrixWorld(e)}},Ve=["hips","spine","chest","upperChest","neck","head","leftEye","rightEye","jaw","leftUpperLeg","leftLowerLeg","leftFoot","leftToes","rightUpperLeg","rightLowerLeg","rightFoot","rightToes","leftShoulder","leftUpperArm","leftLowerArm","leftHand","rightShoulder","rightUpperArm","rightLowerArm","rightHand","leftThumbMetacarpal","leftThumbProximal","leftThumbDistal","leftIndexProximal","leftIndexIntermediate","leftIndexDistal","leftMiddleProximal","leftMiddleIntermediate","leftMiddleDistal","leftRingProximal","leftRingIntermediate","leftRingDistal","leftLittleProximal","leftLittleIntermediate","leftLittleDistal","rightThumbMetacarpal","rightThumbProximal","rightThumbDistal","rightIndexProximal","rightIndexIntermediate","rightIndexDistal","rightMiddleProximal","rightMiddleIntermediate","rightMiddleDistal","rightRingProximal","rightRingIntermediate","rightRingDistal","rightLittleProximal","rightLittleIntermediate","rightLittleDistal"],Zo={Hips:"hips",Spine:"spine",Chest:"chest",UpperChest:"upperChest",Neck:"neck",Head:"head",LeftEye:"leftEye",RightEye:"rightEye",Jaw:"jaw",LeftUpperLeg:"leftUpperLeg",LeftLowerLeg:"leftLowerLeg",LeftFoot:"leftFoot",LeftToes:"leftToes",RightUpperLeg:"rightUpperLeg",RightLowerLeg:"rightLowerLeg",RightFoot:"rightFoot",RightToes:"rightToes",LeftShoulder:"leftShoulder",LeftUpperArm:"leftUpperArm",LeftLowerArm:"leftLowerArm",LeftHand:"leftHand",RightShoulder:"rightShoulder",RightUpperArm:"rightUpperArm",RightLowerArm:"rightLowerArm",RightHand:"rightHand",LeftThumbMetacarpal:"leftThumbMetacarpal",LeftThumbProximal:"leftThumbProximal",LeftThumbDistal:"leftThumbDistal",LeftIndexProximal:"leftIndexProximal",LeftIndexIntermediate:"leftIndexIntermediate",LeftIndexDistal:"leftIndexDistal",LeftMiddleProximal:"leftMiddleProximal",LeftMiddleIntermediate:"leftMiddleIntermediate",LeftMiddleDistal:"leftMiddleDistal",LeftRingProximal:"leftRingProximal",LeftRingIntermediate:"leftRingIntermediate",LeftRingDistal:"leftRingDistal",LeftLittleProximal:"leftLittleProximal",LeftLittleIntermediate:"leftLittleIntermediate",LeftLittleDistal:"leftLittleDistal",RightThumbMetacarpal:"rightThumbMetacarpal",RightThumbProximal:"rightThumbProximal",RightThumbDistal:"rightThumbDistal",RightIndexProximal:"rightIndexProximal",RightIndexIntermediate:"rightIndexIntermediate",RightIndexDistal:"rightIndexDistal",RightMiddleProximal:"rightMiddleProximal",RightMiddleIntermediate:"rightMiddleIntermediate",RightMiddleDistal:"rightMiddleDistal",RightRingProximal:"rightRingProximal",RightRingIntermediate:"rightRingIntermediate",RightRingDistal:"rightRingDistal",RightLittleProximal:"rightLittleProximal",RightLittleIntermediate:"rightLittleIntermediate",RightLittleDistal:"rightLittleDistal"},Xi={hips:null,spine:"hips",chest:"spine",upperChest:"chest",neck:"upperChest",head:"neck",leftEye:"head",rightEye:"head",jaw:"head",leftUpperLeg:"hips",leftLowerLeg:"leftUpperLeg",leftFoot:"leftLowerLeg",leftToes:"leftFoot",rightUpperLeg:"hips",rightLowerLeg:"rightUpperLeg",rightFoot:"rightLowerLeg",rightToes:"rightFoot",leftShoulder:"upperChest",leftUpperArm:"leftShoulder",leftLowerArm:"leftUpperArm",leftHand:"leftLowerArm",rightShoulder:"upperChest",rightUpperArm:"rightShoulder",rightLowerArm:"rightUpperArm",rightHand:"rightLowerArm",leftThumbMetacarpal:"leftHand",leftThumbProximal:"leftThumbMetacarpal",leftThumbDistal:"leftThumbProximal",leftIndexProximal:"leftHand",leftIndexIntermediate:"leftIndexProximal",leftIndexDistal:"leftIndexIntermediate",leftMiddleProximal:"leftHand",leftMiddleIntermediate:"leftMiddleProximal",leftMiddleDistal:"leftMiddleIntermediate",leftRingProximal:"leftHand",leftRingIntermediate:"leftRingProximal",leftRingDistal:"leftRingIntermediate",leftLittleProximal:"leftHand",leftLittleIntermediate:"leftLittleProximal",leftLittleDistal:"leftLittleIntermediate",rightThumbMetacarpal:"rightHand",rightThumbProximal:"rightThumbMetacarpal",rightThumbDistal:"rightThumbProximal",rightIndexProximal:"rightHand",rightIndexIntermediate:"rightIndexProximal",rightIndexDistal:"rightIndexIntermediate",rightMiddleProximal:"rightHand",rightMiddleIntermediate:"rightMiddleProximal",rightMiddleDistal:"rightMiddleIntermediate",rightRingProximal:"rightHand",rightRingIntermediate:"rightRingProximal",rightRingDistal:"rightRingIntermediate",rightLittleProximal:"rightHand",rightLittleIntermediate:"rightLittleProximal",rightLittleDistal:"rightLittleIntermediate"};function Dn(e){return e.invert?e.invert():e.inverse(),e}var q=new g,Q=new E,Qe=class{constructor(e){this.humanBones=e,this.restPose=this.getAbsolutePose()}getAbsolutePose(){const e={};return Object.keys(this.humanBones).forEach(t=>{const n=t,i=this.getBoneNode(n);i&&(q.copy(i.position),Q.copy(i.quaternion),e[n]={position:q.toArray(),rotation:Q.toArray()})}),e}getPose(){const e={};return Object.keys(this.humanBones).forEach(t=>{const n=t,i=this.getBoneNode(n);if(!i)return;q.set(0,0,0),Q.identity();const r=this.restPose[n];r?.position&&q.fromArray(r.position).negate(),r?.rotation&&Dn(Q.fromArray(r.rotation)),q.add(i.position),Q.premultiply(i.quaternion),e[n]={position:q.toArray(),rotation:Q.toArray()}}),e}setPose(e){Object.entries(e).forEach(([t,n])=>{const i=t,r=this.getBoneNode(i);if(!r)return;const o=this.restPose[i];o&&(n?.position&&(r.position.fromArray(n.position),o.position&&r.position.add(q.fromArray(o.position))),n?.rotation&&(r.quaternion.fromArray(n.rotation),o.rotation&&r.quaternion.multiply(Q.fromArray(o.rotation))))})}resetPose(){Object.entries(this.restPose).forEach(([e,t])=>{const n=this.getBoneNode(e);n&&(t?.position&&n.position.fromArray(t.position),t?.rotation&&n.quaternion.fromArray(t.rotation))})}getBone(e){var t;return(t=this.humanBones[e])!=null?t:void 0}getBoneNode(e){var t,n;return(n=(t=this.humanBones[e])==null?void 0:t.node)!=null?n:null}},De=new g,Gi=new E,Yi=new g,Jt=class Bn extends Qe{static _setupTransforms(t){const n=new Ae;n.name="VRMHumanoidRig";const i={},r={},o={};Ve.forEach(l=>{var a;const u=t.getBoneNode(l);if(u){const h=new g,d=new E;u.updateWorldMatrix(!0,!1),u.matrixWorld.decompose(h,d,De),i[l]=h,r[l]=u.quaternion.clone();const c=new E;(a=u.parent)==null||a.matrixWorld.decompose(De,c,De),o[l]=c}});const s={};return Ve.forEach(l=>{var a;const u=t.getBoneNode(l);if(u){const h=i[l];let d=l,c;for(;c==null&&(d=Xi[d],d!=null);)c=i[d];const p=new Ae;p.name="Normalized_"+u.name,(d?(a=s[d])==null?void 0:a.node:n).add(p),p.position.copy(h),c&&p.position.sub(c),s[l]={node:p}}}),{rigBones:s,root:n,parentWorldRotations:o,boneRotations:r}}constructor(t){const{rigBones:n,root:i,parentWorldRotations:r,boneRotations:o}=Bn._setupTransforms(t);super(n),this.original=t,this.root=i,this._parentWorldRotations=r,this._boneRotations=o}update(){Ve.forEach(t=>{const n=this.original.getBoneNode(t);if(n!=null){const i=this.getBoneNode(t),r=this._parentWorldRotations[t],o=Gi.copy(r).invert(),s=this._boneRotations[t];if(n.quaternion.copy(i.quaternion).multiply(r).premultiply(o).multiply(s),t==="hips"){const l=i.getWorldPosition(Yi);n.parent.updateWorldMatrix(!0,!1);const a=n.parent.matrixWorld,u=l.applyMatrix4(a.invert());n.position.copy(u)}}})}},Kt=class Fn{get restPose(){return console.warn("VRMHumanoid: restPose is deprecated. Use either rawRestPose or normalizedRestPose instead."),this.rawRestPose}get rawRestPose(){return this._rawHumanBones.restPose}get normalizedRestPose(){return this._normalizedHumanBones.restPose}get humanBones(){return this._rawHumanBones.humanBones}get rawHumanBones(){return this._rawHumanBones.humanBones}get normalizedHumanBones(){return this._normalizedHumanBones.humanBones}get normalizedHumanBonesRoot(){return this._normalizedHumanBones.root}constructor(t,n){var i;this.autoUpdateHumanBones=(i=n?.autoUpdateHumanBones)!=null?i:!0,this._rawHumanBones=new Qe(t),this._normalizedHumanBones=new Jt(this._rawHumanBones)}copy(t){return this.autoUpdateHumanBones=t.autoUpdateHumanBones,this._rawHumanBones=new Qe(t.humanBones),this._normalizedHumanBones=new Jt(this._rawHumanBones),this}clone(){return new Fn(this.humanBones,{autoUpdateHumanBones:this.autoUpdateHumanBones}).copy(this)}getAbsolutePose(){return console.warn("VRMHumanoid: getAbsolutePose() is deprecated. Use either getRawAbsolutePose() or getNormalizedAbsolutePose() instead."),this.getRawAbsolutePose()}getRawAbsolutePose(){return this._rawHumanBones.getAbsolutePose()}getNormalizedAbsolutePose(){return this._normalizedHumanBones.getAbsolutePose()}getPose(){return console.warn("VRMHumanoid: getPose() is deprecated. Use either getRawPose() or getNormalizedPose() instead."),this.getRawPose()}getRawPose(){return this._rawHumanBones.getPose()}getNormalizedPose(){return this._normalizedHumanBones.getPose()}setPose(t){return console.warn("VRMHumanoid: setPose() is deprecated. Use either setRawPose() or setNormalizedPose() instead."),this.setRawPose(t)}setRawPose(t){return this._rawHumanBones.setPose(t)}setNormalizedPose(t){return this._normalizedHumanBones.setPose(t)}resetPose(){return console.warn("VRMHumanoid: resetPose() is deprecated. Use either resetRawPose() or resetNormalizedPose() instead."),this.resetRawPose()}resetRawPose(){return this._rawHumanBones.resetPose()}resetNormalizedPose(){return this._normalizedHumanBones.resetPose()}getBone(t){return console.warn("VRMHumanoid: getBone() is deprecated. Use either getRawBone() or getNormalizedBone() instead."),this.getRawBone(t)}getRawBone(t){return this._rawHumanBones.getBone(t)}getNormalizedBone(t){return this._normalizedHumanBones.getBone(t)}getBoneNode(t){return console.warn("VRMHumanoid: getBoneNode() is deprecated. Use either getRawBoneNode() or getNormalizedBoneNode() instead."),this.getRawBoneNode(t)}getRawBoneNode(t){return this._rawHumanBones.getBoneNode(t)}getNormalizedBoneNode(t){return this._normalizedHumanBones.getBoneNode(t)}update(){this.autoUpdateHumanBones&&this._normalizedHumanBones.update()}},qi={Hips:"hips",Spine:"spine",Head:"head",LeftUpperLeg:"leftUpperLeg",LeftLowerLeg:"leftLowerLeg",LeftFoot:"leftFoot",RightUpperLeg:"rightUpperLeg",RightLowerLeg:"rightLowerLeg",RightFoot:"rightFoot",LeftUpperArm:"leftUpperArm",LeftLowerArm:"leftLowerArm",LeftHand:"leftHand",RightUpperArm:"rightUpperArm",RightLowerArm:"rightLowerArm",RightHand:"rightHand"},Qi=new Set(["1.0","1.0-beta"]),en={leftThumbProximal:"leftThumbMetacarpal",leftThumbIntermediate:"leftThumbProximal",rightThumbProximal:"rightThumbMetacarpal",rightThumbIntermediate:"rightThumbProximal"},Hn=class{get name(){return"VRMHumanoidLoaderPlugin"}constructor(e,t){this.parser=e,this.helperRoot=t?.helperRoot,this.autoUpdateHumanBones=t?.autoUpdateHumanBones}afterRoot(e){return S(this,null,function*(){e.userData.vrmHumanoid=yield this._import(e)})}_import(e){return S(this,null,function*(){const t=yield this._v1Import(e);if(t)return t;const n=yield this._v0Import(e);return n||null})}_v1Import(e){return S(this,null,function*(){var t,n;const i=this.parser.json;if(!(((t=i.extensionsUsed)==null?void 0:t.indexOf("VRMC_vrm"))!==-1))return null;const o=(n=i.extensions)==null?void 0:n.VRMC_vrm;if(!o)return null;const s=o.specVersion;if(!Qi.has(s))return console.warn(`VRMHumanoidLoaderPlugin: Unknown VRMC_vrm specVersion "${s}"`),null;const l=o.humanoid;if(!l)return null;const a=l.humanBones.leftThumbIntermediate!=null||l.humanBones.rightThumbIntermediate!=null,u={};l.humanBones!=null&&(yield Promise.all(Object.entries(l.humanBones).map(d=>S(this,[d],function*([c,p]){let m=c;const f=p.node;if(a){const v=en[m];v!=null&&(m=v)}const _=yield this.parser.getDependency("node",f);if(_==null){console.warn(`A glTF node bound to the humanoid bone ${m} (index = ${f}) does not exist`);return}u[m]={node:_}}))));const h=new Kt(this._ensureRequiredBonesExist(u),{autoUpdateHumanBones:this.autoUpdateHumanBones});if(e.scene.add(h.normalizedHumanBonesRoot),this.helperRoot){const d=new Zt(h);this.helperRoot.add(d),d.renderOrder=this.helperRoot.renderOrder}return h})}_v0Import(e){return S(this,null,function*(){var t;const i=(t=this.parser.json.extensions)==null?void 0:t.VRM;if(!i)return null;const r=i.humanoid;if(!r)return null;const o={};r.humanBones!=null&&(yield Promise.all(r.humanBones.map(l=>S(this,null,function*(){const a=l.bone,u=l.node;if(a==null||u==null)return;const h=yield this.parser.getDependency("node",u);if(h==null){console.warn(`A glTF node bound to the humanoid bone ${a} (index = ${u}) does not exist`);return}const d=en[a],c=d??a;if(o[c]!=null){console.warn(`Multiple bone entries for ${c} detected (index = ${u}), ignoring duplicated entries.`);return}o[c]={node:h}}))));const s=new Kt(this._ensureRequiredBonesExist(o),{autoUpdateHumanBones:this.autoUpdateHumanBones});if(e.scene.add(s.normalizedHumanBonesRoot),this.helperRoot){const l=new Zt(s);this.helperRoot.add(l),l.renderOrder=this.helperRoot.renderOrder}return s})}_ensureRequiredBonesExist(e){const t=Object.values(qi).filter(n=>e[n]==null);if(t.length>0)throw new Error(`VRMHumanoidLoaderPlugin: These humanoid bones are required but not exist: ${t.join(", ")}`);return e}},tn=class extends j{constructor(){super(),this._currentTheta=0,this._currentRadius=0,this.theta=0,this.radius=0,this._currentTheta=0,this._currentRadius=0,this._attrPos=new C(new Float32Array(195),3),this.setAttribute("position",this._attrPos),this._attrIndex=new C(new Uint16Array(189),1),this.setIndex(this._attrIndex),this._buildIndex(),this.update()}update(){let e=!1;this._currentTheta!==this.theta&&(this._currentTheta=this.theta,e=!0),this._currentRadius!==this.radius&&(this._currentRadius=this.radius,e=!0),e&&this._buildPosition()}_buildPosition(){this._attrPos.setXYZ(0,0,0,0);for(let e=0;e<64;e++){const t=e/63*this._currentTheta;this._attrPos.setXYZ(e+1,this._currentRadius*Math.sin(t),0,this._currentRadius*Math.cos(t))}this._attrPos.needsUpdate=!0}_buildIndex(){for(let e=0;e<63;e++)this._attrIndex.setXYZ(e*3,0,e+1,e+2);this._attrIndex.needsUpdate=!0}},$i=class extends j{constructor(){super(),this.radius=0,this._currentRadius=0,this.tail=new g,this._currentTail=new g,this._attrPos=new C(new Float32Array(294),3),this.setAttribute("position",this._attrPos),this._attrIndex=new C(new Uint16Array(194),1),this.setIndex(this._attrIndex),this._buildIndex(),this.update()}update(){let e=!1;this._currentRadius!==this.radius&&(this._currentRadius=this.radius,e=!0),this._currentTail.equals(this.tail)||(this._currentTail.copy(this.tail),e=!0),e&&this._buildPosition()}_buildPosition(){for(let e=0;e<32;e++){const t=e/16*Math.PI;this._attrPos.setXYZ(e,Math.cos(t),Math.sin(t),0),this._attrPos.setXYZ(32+e,0,Math.cos(t),Math.sin(t)),this._attrPos.setXYZ(64+e,Math.sin(t),0,Math.cos(t))}this.scale(this._currentRadius,this._currentRadius,this._currentRadius),this.translate(this._currentTail.x,this._currentTail.y,this._currentTail.z),this._attrPos.setXYZ(96,0,0,0),this._attrPos.setXYZ(97,this._currentTail.x,this._currentTail.y,this._currentTail.z),this._attrPos.needsUpdate=!0}_buildIndex(){for(let e=0;e<32;e++){const t=(e+1)%32;this._attrIndex.setXY(e*2,e,t),this._attrIndex.setXY(64+e*2,32+e,32+t),this._attrIndex.setXY(128+e*2,64+e,64+t)}this._attrIndex.setXY(192,96,97),this._attrIndex.needsUpdate=!0}},ye=new E,nn=new E,he=new g,rn=new g,on=Math.sqrt(2)/2,Zi=new E(0,0,-on,on),Ji=new g(0,1,0),Ki=class extends re{constructor(e){super(),this.matrixAutoUpdate=!1,this.vrmLookAt=e;{const t=new tn;t.radius=.5;const n=new Bt({color:65280,transparent:!0,opacity:.5,side:Ft,depthTest:!1,depthWrite:!1});this._meshPitch=new Ht(t,n),this.add(this._meshPitch)}{const t=new tn;t.radius=.5;const n=new Bt({color:16711680,transparent:!0,opacity:.5,side:Ft,depthTest:!1,depthWrite:!1});this._meshYaw=new Ht(t,n),this.add(this._meshYaw)}{const t=new $i;t.radius=.1;const n=new Ce({color:16777215,depthTest:!1,depthWrite:!1});this._lineTarget=new nt(t,n),this._lineTarget.frustumCulled=!1,this.add(this._lineTarget)}}dispose(){this._meshYaw.geometry.dispose(),this._meshYaw.material.dispose(),this._meshPitch.geometry.dispose(),this._meshPitch.material.dispose(),this._lineTarget.geometry.dispose(),this._lineTarget.material.dispose()}updateMatrixWorld(e){const t=I.DEG2RAD*this.vrmLookAt.yaw;this._meshYaw.geometry.theta=t,this._meshYaw.geometry.update();const n=I.DEG2RAD*this.vrmLookAt.pitch;this._meshPitch.geometry.theta=n,this._meshPitch.geometry.update(),this.vrmLookAt.getLookAtWorldPosition(he),this.vrmLookAt.getLookAtWorldQuaternion(ye),ye.multiply(this.vrmLookAt.getFaceFrontQuaternion(nn)),this._meshYaw.position.copy(he),this._meshYaw.quaternion.copy(ye),this._meshPitch.position.copy(he),this._meshPitch.quaternion.copy(ye),this._meshPitch.quaternion.multiply(nn.setFromAxisAngle(Ji,t)),this._meshPitch.quaternion.multiply(Zi);const{target:i,autoUpdate:r}=this.vrmLookAt;i!=null&&r&&(i.getWorldPosition(rn).sub(he),this._lineTarget.geometry.tail.copy(rn),this._lineTarget.geometry.update(),this._lineTarget.position.copy(he)),super.updateMatrixWorld(e)}},er=new g,tr=new g;function $e(e,t){return e.matrixWorld.decompose(er,t,tr),t}function Te(e){return[Math.atan2(-e.z,e.x),Math.atan2(e.y,Math.sqrt(e.x*e.x+e.z*e.z))]}function sn(e){const t=Math.round(e/2/Math.PI);return e-2*Math.PI*t}var an=new g(0,0,1),nr=new g,ir=new g,rr=new g,or=new E,Be=new E,ln=new E,sr=new E,Fe=new tt,kn=class Wn{constructor(t,n){this.offsetFromHeadBone=new g,this.autoUpdate=!0,this.faceFront=new g(0,0,1),this.humanoid=t,this.applier=n,this._yaw=0,this._pitch=0,this._needsUpdate=!0,this._restHeadWorldQuaternion=this.getLookAtWorldQuaternion(new E)}get yaw(){return this._yaw}set yaw(t){this._yaw=t,this._needsUpdate=!0}get pitch(){return this._pitch}set pitch(t){this._pitch=t,this._needsUpdate=!0}get euler(){return console.warn("VRMLookAt: euler is deprecated. use getEuler() instead."),this.getEuler(new tt)}getEuler(t){return t.set(I.DEG2RAD*this._pitch,I.DEG2RAD*this._yaw,0,"YXZ")}copy(t){if(this.humanoid!==t.humanoid)throw new Error("VRMLookAt: humanoid must be same in order to copy");return this.offsetFromHeadBone.copy(t.offsetFromHeadBone),this.applier=t.applier,this.autoUpdate=t.autoUpdate,this.target=t.target,this.faceFront.copy(t.faceFront),this}clone(){return new Wn(this.humanoid,this.applier).copy(this)}reset(){this._yaw=0,this._pitch=0,this._needsUpdate=!0}getLookAtWorldPosition(t){const n=this.humanoid.getRawBoneNode("head");return t.copy(this.offsetFromHeadBone).applyMatrix4(n.matrixWorld)}getLookAtWorldQuaternion(t){const n=this.humanoid.getRawBoneNode("head");return $e(n,t)}getFaceFrontQuaternion(t){if(this.faceFront.distanceToSquared(an)<.01)return t.copy(this._restHeadWorldQuaternion).invert();const[n,i]=Te(this.faceFront);return Fe.set(0,.5*Math.PI+n,i,"YZX"),t.setFromEuler(Fe).premultiply(sr.copy(this._restHeadWorldQuaternion).invert())}getLookAtWorldDirection(t){return this.getLookAtWorldQuaternion(Be),this.getFaceFrontQuaternion(ln),t.copy(an).applyQuaternion(Be).applyQuaternion(ln).applyEuler(this.getEuler(Fe))}lookAt(t){const n=or.copy(this._restHeadWorldQuaternion).multiply(Dn(this.getLookAtWorldQuaternion(Be))),i=this.getLookAtWorldPosition(ir),r=rr.copy(t).sub(i).applyQuaternion(n).normalize(),[o,s]=Te(this.faceFront),[l,a]=Te(r),u=sn(l-o),h=sn(s-a);this._yaw=I.RAD2DEG*u,this._pitch=I.RAD2DEG*h,this._needsUpdate=!0}update(t){this.target!=null&&this.autoUpdate&&this.lookAt(this.target.getWorldPosition(nr)),this._needsUpdate&&(this._needsUpdate=!1,this.applier.applyYawPitch(this._yaw,this._pitch))}};kn.EULER_ORDER="YXZ";var ar=kn,lr=new g(0,0,1),B=new E,K=new E,N=new tt(0,0,0,"YXZ"),Se=class{constructor(e,t,n,i,r){this.humanoid=e,this.rangeMapHorizontalInner=t,this.rangeMapHorizontalOuter=n,this.rangeMapVerticalDown=i,this.rangeMapVerticalUp=r,this.faceFront=new g(0,0,1),this._restQuatLeftEye=new E,this._restQuatRightEye=new E,this._restLeftEyeParentWorldQuat=new E,this._restRightEyeParentWorldQuat=new E;const o=this.humanoid.getRawBoneNode("leftEye"),s=this.humanoid.getRawBoneNode("rightEye");o&&(this._restQuatLeftEye.copy(o.quaternion),$e(o.parent,this._restLeftEyeParentWorldQuat)),s&&(this._restQuatRightEye.copy(s.quaternion),$e(s.parent,this._restRightEyeParentWorldQuat))}applyYawPitch(e,t){const n=this.humanoid.getRawBoneNode("leftEye"),i=this.humanoid.getRawBoneNode("rightEye"),r=this.humanoid.getNormalizedBoneNode("leftEye"),o=this.humanoid.getNormalizedBoneNode("rightEye");n&&(t<0?N.x=-I.DEG2RAD*this.rangeMapVerticalDown.map(-t):N.x=I.DEG2RAD*this.rangeMapVerticalUp.map(t),e<0?N.y=-I.DEG2RAD*this.rangeMapHorizontalInner.map(-e):N.y=I.DEG2RAD*this.rangeMapHorizontalOuter.map(e),B.setFromEuler(N),this._getWorldFaceFrontQuat(K),r.quaternion.copy(K).multiply(B).multiply(K.invert()),B.copy(this._restLeftEyeParentWorldQuat),n.quaternion.copy(r.quaternion).multiply(B).premultiply(B.invert()).multiply(this._restQuatLeftEye)),i&&(t<0?N.x=-I.DEG2RAD*this.rangeMapVerticalDown.map(-t):N.x=I.DEG2RAD*this.rangeMapVerticalUp.map(t),e<0?N.y=-I.DEG2RAD*this.rangeMapHorizontalOuter.map(-e):N.y=I.DEG2RAD*this.rangeMapHorizontalInner.map(e),B.setFromEuler(N),this._getWorldFaceFrontQuat(K),o.quaternion.copy(K).multiply(B).multiply(K.invert()),B.copy(this._restRightEyeParentWorldQuat),i.quaternion.copy(o.quaternion).multiply(B).premultiply(B.invert()).multiply(this._restQuatRightEye))}lookAt(e){console.warn("VRMLookAtBoneApplier: lookAt() is deprecated. use apply() instead.");const t=I.RAD2DEG*e.y,n=I.RAD2DEG*e.x;this.applyYawPitch(t,n)}_getWorldFaceFrontQuat(e){if(this.faceFront.distanceToSquared(lr)<.01)return e.identity();const[t,n]=Te(this.faceFront);return N.set(0,.5*Math.PI+t,n,"YZX"),e.setFromEuler(N)}};Se.type="bone";var Ze=class{constructor(e,t,n,i,r){this.expressions=e,this.rangeMapHorizontalInner=t,this.rangeMapHorizontalOuter=n,this.rangeMapVerticalDown=i,this.rangeMapVerticalUp=r}applyYawPitch(e,t){t<0?(this.expressions.setValue("lookDown",0),this.expressions.setValue("lookUp",this.rangeMapVerticalUp.map(-t))):(this.expressions.setValue("lookUp",0),this.expressions.setValue("lookDown",this.rangeMapVerticalDown.map(t))),e<0?(this.expressions.setValue("lookLeft",0),this.expressions.setValue("lookRight",this.rangeMapHorizontalOuter.map(-e))):(this.expressions.setValue("lookRight",0),this.expressions.setValue("lookLeft",this.rangeMapHorizontalOuter.map(e)))}lookAt(e){console.warn("VRMLookAtBoneApplier: lookAt() is deprecated. use apply() instead.");const t=I.RAD2DEG*e.y,n=I.RAD2DEG*e.x;this.applyYawPitch(t,n)}};Ze.type="expression";var un=class{constructor(e,t){this.inputMaxValue=e,this.outputScale=t}map(e){return this.outputScale*An(e/this.inputMaxValue)}},ur=new Set(["1.0","1.0-beta"]),Re=.01,zn=class{get name(){return"VRMLookAtLoaderPlugin"}constructor(e,t){this.parser=e,this.helperRoot=t?.helperRoot}afterRoot(e){return S(this,null,function*(){const t=e.userData.vrmHumanoid;if(t===null)return;if(t===void 0)throw new Error("VRMLookAtLoaderPlugin: vrmHumanoid is undefined. VRMHumanoidLoaderPlugin have to be used first");const n=e.userData.vrmExpressionManager;if(n!==null){if(n===void 0)throw new Error("VRMLookAtLoaderPlugin: vrmExpressionManager is undefined. VRMExpressionLoaderPlugin have to be used first");e.userData.vrmLookAt=yield this._import(e,t,n)}})}_import(e,t,n){return S(this,null,function*(){if(t==null||n==null)return null;const i=yield this._v1Import(e,t,n);if(i)return i;const r=yield this._v0Import(e,t,n);return r||null})}_v1Import(e,t,n){return S(this,null,function*(){var i,r,o;const s=this.parser.json;if(!(((i=s.extensionsUsed)==null?void 0:i.indexOf("VRMC_vrm"))!==-1))return null;const a=(r=s.extensions)==null?void 0:r.VRMC_vrm;if(!a)return null;const u=a.specVersion;if(!ur.has(u))return console.warn(`VRMLookAtLoaderPlugin: Unknown VRMC_vrm specVersion "${u}"`),null;const h=a.lookAt;if(!h)return null;const d=h.type==="expression"?1:10,c=this._v1ImportRangeMap(h.rangeMapHorizontalInner,d),p=this._v1ImportRangeMap(h.rangeMapHorizontalOuter,d),m=this._v1ImportRangeMap(h.rangeMapVerticalDown,d),f=this._v1ImportRangeMap(h.rangeMapVerticalUp,d);let _;h.type==="expression"?_=new Ze(n,c,p,m,f):_=new Se(t,c,p,m,f);const v=this._importLookAt(t,_);return v.offsetFromHeadBone.fromArray((o=h.offsetFromHeadBone)!=null?o:[0,.06,0]),v})}_v1ImportRangeMap(e,t){var n,i;let r=(n=e?.inputMaxValue)!=null?n:90;const o=(i=e?.outputScale)!=null?i:t;return r<Re&&(console.warn("VRMLookAtLoaderPlugin: inputMaxValue of a range map is too small. Consider reviewing the range map!"),r=Re),new un(r,o)}_v0Import(e,t,n){return S(this,null,function*(){var i,r,o,s;const a=(i=this.parser.json.extensions)==null?void 0:i.VRM;if(!a)return null;const u=a.firstPerson;if(!u)return null;const h=u.lookAtTypeName==="BlendShape"?1:10,d=this._v0ImportDegreeMap(u.lookAtHorizontalInner,h),c=this._v0ImportDegreeMap(u.lookAtHorizontalOuter,h),p=this._v0ImportDegreeMap(u.lookAtVerticalDown,h),m=this._v0ImportDegreeMap(u.lookAtVerticalUp,h);let f;u.lookAtTypeName==="BlendShape"?f=new Ze(n,d,c,p,m):f=new Se(t,d,c,p,m);const _=this._importLookAt(t,f);return u.firstPersonBoneOffset?_.offsetFromHeadBone.set((r=u.firstPersonBoneOffset.x)!=null?r:0,(o=u.firstPersonBoneOffset.y)!=null?o:.06,-((s=u.firstPersonBoneOffset.z)!=null?s:0)):_.offsetFromHeadBone.set(0,.06,0),_.faceFront.set(0,0,-1),f instanceof Se&&f.faceFront.set(0,0,-1),_})}_v0ImportDegreeMap(e,t){var n,i;const r=e?.curve;JSON.stringify(r)!=="[0,0,0,1,1,1,1,0]"&&console.warn("Curves of LookAtDegreeMap defined in VRM 0.0 are not supported");let o=(n=e?.xRange)!=null?n:90;const s=(i=e?.yRange)!=null?i:t;return o<Re&&(console.warn("VRMLookAtLoaderPlugin: xRange of a degree map is too small. Consider reviewing the degree map!"),o=Re),new un(o,s)}_importLookAt(e,t){const n=new ar(e,t);if(this.helperRoot){const i=new Ki(n);this.helperRoot.add(i),i.renderOrder=this.helperRoot.renderOrder}return n}},Jo={Bone:"bone",Expression:"expression"};function dr(e,t){return typeof e!="string"||e===""?"":(/^https?:\/\//i.test(t)&&/^\//.test(e)&&(t=t.replace(/(^https?:\/\/[^/]+).*/i,"$1")),/^(https?:)?\/\//i.test(e)||/^data:.*,.*$/i.test(e)||/^blob:.*$/i.test(e)?e:t+e)}var hr=new Set(["1.0","1.0-beta"]),jn=class{get name(){return"VRMMetaLoaderPlugin"}constructor(e,t){var n,i,r;this.parser=e,this.needThumbnailImage=(n=t?.needThumbnailImage)!=null?n:!1,this.acceptLicenseUrls=(i=t?.acceptLicenseUrls)!=null?i:["https://vrm.dev/licenses/1.0/"],this.acceptV0Meta=(r=t?.acceptV0Meta)!=null?r:!0}afterRoot(e){return S(this,null,function*(){e.userData.vrmMeta=yield this._import(e)})}_import(e){return S(this,null,function*(){const t=yield this._v1Import(e);if(t!=null)return t;const n=yield this._v0Import(e);return n??null})}_v1Import(e){return S(this,null,function*(){var t,n,i;const r=this.parser.json;if(!(((t=r.extensionsUsed)==null?void 0:t.indexOf("VRMC_vrm"))!==-1))return null;const s=(n=r.extensions)==null?void 0:n.VRMC_vrm;if(s==null)return null;const l=s.specVersion;if(!hr.has(l))return console.warn(`VRMMetaLoaderPlugin: Unknown VRMC_vrm specVersion "${l}"`),null;const a=s.meta;if(!a)return null;const u=a.licenseUrl;if(!new Set(this.acceptLicenseUrls).has(u))throw new Error(`VRMMetaLoaderPlugin: The license url "${u}" is not accepted`);let d;return this.needThumbnailImage&&a.thumbnailImage!=null&&(d=(i=yield this._extractGLTFImage(a.thumbnailImage))!=null?i:void 0),{metaVersion:"1",name:a.name,version:a.version,authors:a.authors,copyrightInformation:a.copyrightInformation,contactInformation:a.contactInformation,references:a.references,thirdPartyLicenses:a.thirdPartyLicenses,thumbnailImage:d,licenseUrl:a.licenseUrl,avatarPermission:a.avatarPermission,allowExcessivelyViolentUsage:a.allowExcessivelyViolentUsage,allowExcessivelySexualUsage:a.allowExcessivelySexualUsage,commercialUsage:a.commercialUsage,allowPoliticalOrReligiousUsage:a.allowPoliticalOrReligiousUsage,allowAntisocialOrHateUsage:a.allowAntisocialOrHateUsage,creditNotation:a.creditNotation,allowRedistribution:a.allowRedistribution,modification:a.modification,otherLicenseUrl:a.otherLicenseUrl}})}_v0Import(e){return S(this,null,function*(){var t;const i=(t=this.parser.json.extensions)==null?void 0:t.VRM;if(!i)return null;const r=i.meta;if(!r)return null;if(!this.acceptV0Meta)throw new Error("VRMMetaLoaderPlugin: Attempted to load VRM0.0 meta but acceptV0Meta is false");let o;return this.needThumbnailImage&&r.texture!=null&&r.texture!==-1&&(o=yield this.parser.getDependency("texture",r.texture)),{metaVersion:"0",allowedUserName:r.allowedUserName,author:r.author,commercialUssageName:r.commercialUssageName,contactInformation:r.contactInformation,licenseName:r.licenseName,otherLicenseUrl:r.otherLicenseUrl,otherPermissionUrl:r.otherPermissionUrl,reference:r.reference,sexualUssageName:r.sexualUssageName,texture:o??void 0,title:r.title,version:r.version,violentUssageName:r.violentUssageName}})}_extractGLTFImage(e){return S(this,null,function*(){var t;const i=(t=this.parser.json.images)==null?void 0:t[e];if(i==null)return console.warn(`VRMMetaLoaderPlugin: Attempt to use images[${e}] of glTF as a thumbnail but the image doesn't exist`),null;let r=i.uri;if(i.bufferView!=null){const s=yield this.parser.getDependency("bufferView",i.bufferView),l=new Blob([s],{type:i.mimeType});r=URL.createObjectURL(l)}return r==null?(console.warn(`VRMMetaLoaderPlugin: Attempt to use images[${e}] of glTF as a thumbnail but the image couldn't load properly`),null):yield new Fi().loadAsync(dr(r,this.parser.options.path)).catch(s=>(console.error(s),console.warn("VRMMetaLoaderPlugin: Failed to load a thumbnail image"),null))})}},Xn=class{constructor(e){this.scene=e.scene,this.meta=e.meta,this.humanoid=e.humanoid,this.expressionManager=e.expressionManager,this.firstPerson=e.firstPerson,this.lookAt=e.lookAt}update(e){this.humanoid.update(),this.lookAt&&this.lookAt.update(e),this.expressionManager&&this.expressionManager.update()}},Ko=class{get name(){return"VRMC_vrm"}constructor(e,t){var n,i,r,o,s;this.parser=e;const l=t?.helperRoot,a=t?.autoUpdateHumanBones;this.expressionPlugin=(n=t?.expressionPlugin)!=null?n:new Nn(e),this.firstPersonPlugin=(i=t?.firstPersonPlugin)!=null?i:new Vn(e),this.humanoidPlugin=(r=t?.humanoidPlugin)!=null?r:new Hn(e,{helperRoot:l,autoUpdateHumanBones:a}),this.lookAtPlugin=(o=t?.lookAtPlugin)!=null?o:new zn(e,{helperRoot:l}),this.metaPlugin=(s=t?.metaPlugin)!=null?s:new jn(e)}afterRoot(e){return S(this,null,function*(){yield this.metaPlugin.afterRoot(e),yield this.humanoidPlugin.afterRoot(e),yield this.expressionPlugin.afterRoot(e),yield this.lookAtPlugin.afterRoot(e),yield this.firstPersonPlugin.afterRoot(e);const t=e.userData.vrmMeta,n=e.userData.vrmHumanoid;if(t&&n){const i=new Xn({scene:e.scene,expressionManager:e.userData.vrmExpressionManager,firstPerson:e.userData.vrmFirstPerson,humanoid:n,lookAt:e.userData.vrmLookAt,meta:t});e.userData.vrmCore=i}})}},cr=class extends Xn{constructor(e){super(e),this.materials=e.materials,this.springBoneManager=e.springBoneManager,this.nodeConstraintManager=e.nodeConstraintManager}update(e){super.update(e),this.nodeConstraintManager&&this.nodeConstraintManager.update(),this.springBoneManager&&this.springBoneManager.update(e),this.materials&&this.materials.forEach(t=>{t.update&&t.update(e)})}},pr=Object.defineProperty,dn=Object.getOwnPropertySymbols,fr=Object.prototype.hasOwnProperty,mr=Object.prototype.propertyIsEnumerable,hn=(e,t,n)=>t in e?pr(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n,cn=(e,t)=>{for(var n in t||(t={}))fr.call(t,n)&&hn(e,n,t[n]);if(dn)for(var n of dn(t))mr.call(t,n)&&hn(e,n,t[n]);return e},Z=(e,t,n)=>new Promise((i,r)=>{var o=a=>{try{l(n.next(a))}catch(u){r(u)}},s=a=>{try{l(n.throw(a))}catch(u){r(u)}},l=a=>a.done?i(a.value):Promise.resolve(a.value).then(o,s);l((n=n.apply(e,t)).next())}),_r={"":3e3,srgb:3001};function gr(e,t){parseInt(Pe,10)>=152?e.colorSpace=t:e.encoding=_r[t]}var vr=class{get pending(){return Promise.all(this._pendings)}constructor(e,t){this._parser=e,this._materialParams=t,this._pendings=[]}assignPrimitive(e,t){t!=null&&(this._materialParams[e]=t)}assignColor(e,t,n){if(t!=null){const i=new V().fromArray(t);n&&i.convertSRGBToLinear(),this._materialParams[e]=i}}assignTexture(e,t,n){return Z(this,null,function*(){const i=Z(this,null,function*(){if(t!=null){const r=yield this._parser.assignTexture(this._materialParams,e,t);if(r==null){console.warn("GLTFMToonMaterialParamsAssignHelper: Failed to load texture. The rendering result may be wrong");return}n&&gr(r,"srgb")}});return this._pendings.push(i),i})}assignTextureByIndex(e,t,n){return Z(this,null,function*(){return this.assignTexture(e,t!=null?{index:t}:void 0,n)})}},Mr=`// #define PHONG

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

}`,xr=`// #define PHONG

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
`,yr={None:"none",Normal:"normal",LitShadeRate:"litShadeRate",UV:"uv"},pn={None:"none",WorldCoordinates:"worldCoordinates",ScreenCoordinates:"screenCoordinates"},Rr={3e3:"",3001:"srgb"};function He(e){return parseInt(Pe,10)>=152?e.colorSpace:Rr[e.encoding]}var wr=class extends bi{constructor(e={}){var t;super({vertexShader:Mr,fragmentShader:xr}),this.uvAnimationScrollXSpeedFactor=0,this.uvAnimationScrollYSpeedFactor=0,this.uvAnimationRotationSpeedFactor=0,this.fog=!0,this.normalMapType=Ii,this._ignoreVertexColor=!0,this._v0CompatShade=!1,this._debugMode=yr.None,this._outlineWidthMode=pn.None,this._isOutline=!1,e.transparentWithZWrite&&(e.depthWrite=!0),delete e.transparentWithZWrite,e.fog=!0,e.lights=!0,e.clipping=!0,this.uniforms=Oi.merge([ue.common,ue.normalmap,ue.emissivemap,ue.fog,ue.lights,{litFactor:{value:new V(1,1,1)},mapUvTransform:{value:new k},colorAlpha:{value:1},normalMapUvTransform:{value:new k},shadeColorFactor:{value:new V(0,0,0)},shadeMultiplyTexture:{value:null},shadeMultiplyTextureUvTransform:{value:new k},shadingShiftFactor:{value:0},shadingShiftTexture:{value:null},shadingShiftTextureUvTransform:{value:new k},shadingShiftTextureScale:{value:1},shadingToonyFactor:{value:.9},giEqualizationFactor:{value:.9},matcapFactor:{value:new V(1,1,1)},matcapTexture:{value:null},matcapTextureUvTransform:{value:new k},parametricRimColorFactor:{value:new V(0,0,0)},rimMultiplyTexture:{value:null},rimMultiplyTextureUvTransform:{value:new k},rimLightingMixFactor:{value:1},parametricRimFresnelPowerFactor:{value:5},parametricRimLiftFactor:{value:0},emissive:{value:new V(0,0,0)},emissiveIntensity:{value:1},emissiveMapUvTransform:{value:new k},outlineWidthMultiplyTexture:{value:null},outlineWidthMultiplyTextureUvTransform:{value:new k},outlineWidthFactor:{value:0},outlineColorFactor:{value:new V(0,0,0)},outlineLightingMixFactor:{value:1},uvAnimationMaskTexture:{value:null},uvAnimationMaskTextureUvTransform:{value:new k},uvAnimationScrollXOffset:{value:0},uvAnimationScrollYOffset:{value:0},uvAnimationRotationPhase:{value:0}},(t=e.uniforms)!=null?t:{}]),this.setValues(e),this._uploadUniformsWorkaround(),this.customProgramCacheKey=()=>[...Object.entries(this._generateDefines()).map(([n,i])=>`${n}:${i}`),this.matcapTexture?`matcapTextureColorSpace:${He(this.matcapTexture)}`:"",this.shadeMultiplyTexture?`shadeMultiplyTextureColorSpace:${He(this.shadeMultiplyTexture)}`:"",this.rimMultiplyTexture?`rimMultiplyTextureColorSpace:${He(this.rimMultiplyTexture)}`:""].join(","),this.onBeforeCompile=n=>{const i=parseInt(Pe,10),r=Object.entries(cn(cn({},this._generateDefines()),this.defines)).filter(([o,s])=>!!s).map(([o,s])=>`#define ${o} ${s}`).join(`
`)+`
`;n.vertexShader=r+n.vertexShader,n.fragmentShader=r+n.fragmentShader,i<154&&(n.fragmentShader=n.fragmentShader.replace("#include <colorspace_fragment>","#include <encodings_fragment>"))}}get color(){return this.uniforms.litFactor.value}set color(e){this.uniforms.litFactor.value=e}get map(){return this.uniforms.map.value}set map(e){this.uniforms.map.value=e}get normalMap(){return this.uniforms.normalMap.value}set normalMap(e){this.uniforms.normalMap.value=e}get normalScale(){return this.uniforms.normalScale.value}set normalScale(e){this.uniforms.normalScale.value=e}get emissive(){return this.uniforms.emissive.value}set emissive(e){this.uniforms.emissive.value=e}get emissiveIntensity(){return this.uniforms.emissiveIntensity.value}set emissiveIntensity(e){this.uniforms.emissiveIntensity.value=e}get emissiveMap(){return this.uniforms.emissiveMap.value}set emissiveMap(e){this.uniforms.emissiveMap.value=e}get shadeColorFactor(){return this.uniforms.shadeColorFactor.value}set shadeColorFactor(e){this.uniforms.shadeColorFactor.value=e}get shadeMultiplyTexture(){return this.uniforms.shadeMultiplyTexture.value}set shadeMultiplyTexture(e){this.uniforms.shadeMultiplyTexture.value=e}get shadingShiftFactor(){return this.uniforms.shadingShiftFactor.value}set shadingShiftFactor(e){this.uniforms.shadingShiftFactor.value=e}get shadingShiftTexture(){return this.uniforms.shadingShiftTexture.value}set shadingShiftTexture(e){this.uniforms.shadingShiftTexture.value=e}get shadingShiftTextureScale(){return this.uniforms.shadingShiftTextureScale.value}set shadingShiftTextureScale(e){this.uniforms.shadingShiftTextureScale.value=e}get shadingToonyFactor(){return this.uniforms.shadingToonyFactor.value}set shadingToonyFactor(e){this.uniforms.shadingToonyFactor.value=e}get giEqualizationFactor(){return this.uniforms.giEqualizationFactor.value}set giEqualizationFactor(e){this.uniforms.giEqualizationFactor.value=e}get matcapFactor(){return this.uniforms.matcapFactor.value}set matcapFactor(e){this.uniforms.matcapFactor.value=e}get matcapTexture(){return this.uniforms.matcapTexture.value}set matcapTexture(e){this.uniforms.matcapTexture.value=e}get parametricRimColorFactor(){return this.uniforms.parametricRimColorFactor.value}set parametricRimColorFactor(e){this.uniforms.parametricRimColorFactor.value=e}get rimMultiplyTexture(){return this.uniforms.rimMultiplyTexture.value}set rimMultiplyTexture(e){this.uniforms.rimMultiplyTexture.value=e}get rimLightingMixFactor(){return this.uniforms.rimLightingMixFactor.value}set rimLightingMixFactor(e){this.uniforms.rimLightingMixFactor.value=e}get parametricRimFresnelPowerFactor(){return this.uniforms.parametricRimFresnelPowerFactor.value}set parametricRimFresnelPowerFactor(e){this.uniforms.parametricRimFresnelPowerFactor.value=e}get parametricRimLiftFactor(){return this.uniforms.parametricRimLiftFactor.value}set parametricRimLiftFactor(e){this.uniforms.parametricRimLiftFactor.value=e}get outlineWidthMultiplyTexture(){return this.uniforms.outlineWidthMultiplyTexture.value}set outlineWidthMultiplyTexture(e){this.uniforms.outlineWidthMultiplyTexture.value=e}get outlineWidthFactor(){return this.uniforms.outlineWidthFactor.value}set outlineWidthFactor(e){this.uniforms.outlineWidthFactor.value=e}get outlineColorFactor(){return this.uniforms.outlineColorFactor.value}set outlineColorFactor(e){this.uniforms.outlineColorFactor.value=e}get outlineLightingMixFactor(){return this.uniforms.outlineLightingMixFactor.value}set outlineLightingMixFactor(e){this.uniforms.outlineLightingMixFactor.value=e}get uvAnimationMaskTexture(){return this.uniforms.uvAnimationMaskTexture.value}set uvAnimationMaskTexture(e){this.uniforms.uvAnimationMaskTexture.value=e}get uvAnimationScrollXOffset(){return this.uniforms.uvAnimationScrollXOffset.value}set uvAnimationScrollXOffset(e){this.uniforms.uvAnimationScrollXOffset.value=e}get uvAnimationScrollYOffset(){return this.uniforms.uvAnimationScrollYOffset.value}set uvAnimationScrollYOffset(e){this.uniforms.uvAnimationScrollYOffset.value=e}get uvAnimationRotationPhase(){return this.uniforms.uvAnimationRotationPhase.value}set uvAnimationRotationPhase(e){this.uniforms.uvAnimationRotationPhase.value=e}get ignoreVertexColor(){return this._ignoreVertexColor}set ignoreVertexColor(e){this._ignoreVertexColor=e,this.needsUpdate=!0}get v0CompatShade(){return this._v0CompatShade}set v0CompatShade(e){this._v0CompatShade=e,this.needsUpdate=!0}get debugMode(){return this._debugMode}set debugMode(e){this._debugMode=e,this.needsUpdate=!0}get outlineWidthMode(){return this._outlineWidthMode}set outlineWidthMode(e){this._outlineWidthMode=e,this.needsUpdate=!0}get isOutline(){return this._isOutline}set isOutline(e){this._isOutline=e,this.needsUpdate=!0}get isMToonMaterial(){return!0}update(e){this._uploadUniformsWorkaround(),this._updateUVAnimation(e)}copy(e){return super.copy(e),this.map=e.map,this.normalMap=e.normalMap,this.emissiveMap=e.emissiveMap,this.shadeMultiplyTexture=e.shadeMultiplyTexture,this.shadingShiftTexture=e.shadingShiftTexture,this.matcapTexture=e.matcapTexture,this.rimMultiplyTexture=e.rimMultiplyTexture,this.outlineWidthMultiplyTexture=e.outlineWidthMultiplyTexture,this.uvAnimationMaskTexture=e.uvAnimationMaskTexture,this.normalMapType=e.normalMapType,this.uvAnimationScrollXSpeedFactor=e.uvAnimationScrollXSpeedFactor,this.uvAnimationScrollYSpeedFactor=e.uvAnimationScrollYSpeedFactor,this.uvAnimationRotationSpeedFactor=e.uvAnimationRotationSpeedFactor,this.ignoreVertexColor=e.ignoreVertexColor,this.v0CompatShade=e.v0CompatShade,this.debugMode=e.debugMode,this.outlineWidthMode=e.outlineWidthMode,this.isOutline=e.isOutline,this.needsUpdate=!0,this}_updateUVAnimation(e){this.uniforms.uvAnimationScrollXOffset.value+=e*this.uvAnimationScrollXSpeedFactor,this.uniforms.uvAnimationScrollYOffset.value+=e*this.uvAnimationScrollYSpeedFactor,this.uniforms.uvAnimationRotationPhase.value+=e*this.uvAnimationRotationSpeedFactor,this.uniforms.alphaTest.value=this.alphaTest,this.uniformsNeedUpdate=!0}_uploadUniformsWorkaround(){this.uniforms.opacity.value=this.opacity,this._updateTextureMatrix(this.uniforms.map,this.uniforms.mapUvTransform),this._updateTextureMatrix(this.uniforms.normalMap,this.uniforms.normalMapUvTransform),this._updateTextureMatrix(this.uniforms.emissiveMap,this.uniforms.emissiveMapUvTransform),this._updateTextureMatrix(this.uniforms.shadeMultiplyTexture,this.uniforms.shadeMultiplyTextureUvTransform),this._updateTextureMatrix(this.uniforms.shadingShiftTexture,this.uniforms.shadingShiftTextureUvTransform),this._updateTextureMatrix(this.uniforms.matcapTexture,this.uniforms.matcapTextureUvTransform),this._updateTextureMatrix(this.uniforms.rimMultiplyTexture,this.uniforms.rimMultiplyTextureUvTransform),this._updateTextureMatrix(this.uniforms.outlineWidthMultiplyTexture,this.uniforms.outlineWidthMultiplyTextureUvTransform),this._updateTextureMatrix(this.uniforms.uvAnimationMaskTexture,this.uniforms.uvAnimationMaskTextureUvTransform),this.uniformsNeedUpdate=!0}_generateDefines(){const e=parseInt(Pe,10),t=this.outlineWidthMultiplyTexture!==null,n=this.map!==null||this.normalMap!==null||this.emissiveMap!==null||this.shadeMultiplyTexture!==null||this.shadingShiftTexture!==null||this.rimMultiplyTexture!==null||this.uvAnimationMaskTexture!==null;return{THREE_VRM_THREE_REVISION:e,OUTLINE:this._isOutline,MTOON_USE_UV:t||n,MTOON_UVS_VERTEX_ONLY:t&&!n,V0_COMPAT_SHADE:this._v0CompatShade,USE_SHADEMULTIPLYTEXTURE:this.shadeMultiplyTexture!==null,USE_SHADINGSHIFTTEXTURE:this.shadingShiftTexture!==null,USE_MATCAPTEXTURE:this.matcapTexture!==null,USE_RIMMULTIPLYTEXTURE:this.rimMultiplyTexture!==null,USE_OUTLINEWIDTHMULTIPLYTEXTURE:this._isOutline&&this.outlineWidthMultiplyTexture!==null,USE_UVANIMATIONMASKTEXTURE:this.uvAnimationMaskTexture!==null,IGNORE_VERTEX_COLOR:this._ignoreVertexColor===!0,DEBUG_NORMAL:this._debugMode==="normal",DEBUG_LITSHADERATE:this._debugMode==="litShadeRate",DEBUG_UV:this._debugMode==="uv",OUTLINE_WIDTH_SCREEN:this._isOutline&&this._outlineWidthMode===pn.ScreenCoordinates}}_updateTextureMatrix(e,t){e.value&&(e.value.matrixAutoUpdate&&e.value.updateMatrix(),t.value.copy(e.value.matrix))}},Tr=new Set(["1.0","1.0-beta"]),Gn=class Ee{get name(){return Ee.EXTENSION_NAME}constructor(t,n={}){var i,r,o,s;this.parser=t,this.materialType=(i=n.materialType)!=null?i:wr,this.renderOrderOffset=(r=n.renderOrderOffset)!=null?r:0,this.v0CompatShade=(o=n.v0CompatShade)!=null?o:!1,this.debugMode=(s=n.debugMode)!=null?s:"none",this._mToonMaterialSet=new Set}beforeRoot(){return Z(this,null,function*(){this._removeUnlitExtensionIfMToonExists()})}afterRoot(t){return Z(this,null,function*(){t.userData.vrmMToonMaterials=Array.from(this._mToonMaterialSet)})}getMaterialType(t){return this._getMToonExtension(t)?this.materialType:null}extendMaterialParams(t,n){const i=this._getMToonExtension(t);return i?this._extendMaterialParams(i,n):null}loadMesh(t){return Z(this,null,function*(){var n;const i=this.parser,o=(n=i.json.meshes)==null?void 0:n[t];if(o==null)throw new Error(`MToonMaterialLoaderPlugin: Attempt to use meshes[${t}] of glTF but the mesh doesn't exist`);const s=o.primitives,l=yield i.loadMesh(t);if(s.length===1){const a=l,u=s[0].material;u!=null&&this._setupPrimitive(a,u)}else{const a=l;for(let u=0;u<s.length;u++){const h=a.children[u],d=s[u].material;d!=null&&this._setupPrimitive(h,d)}}return l})}_removeUnlitExtensionIfMToonExists(){const i=this.parser.json.materials;i?.map((r,o)=>{var s;this._getMToonExtension(o)&&((s=r.extensions)!=null&&s.KHR_materials_unlit)&&delete r.extensions.KHR_materials_unlit})}_getMToonExtension(t){var n,i;const s=(n=this.parser.json.materials)==null?void 0:n[t];if(s==null){console.warn(`MToonMaterialLoaderPlugin: Attempt to use materials[${t}] of glTF but the material doesn't exist`);return}const l=(i=s.extensions)==null?void 0:i[Ee.EXTENSION_NAME];if(l==null)return;const a=l.specVersion;if(!Tr.has(a)){console.warn(`MToonMaterialLoaderPlugin: Unknown ${Ee.EXTENSION_NAME} specVersion "${a}"`);return}return l}_extendMaterialParams(t,n){return Z(this,null,function*(){var i;delete n.metalness,delete n.roughness;const r=new vr(this.parser,n);r.assignPrimitive("transparentWithZWrite",t.transparentWithZWrite),r.assignColor("shadeColorFactor",t.shadeColorFactor),r.assignTexture("shadeMultiplyTexture",t.shadeMultiplyTexture,!0),r.assignPrimitive("shadingShiftFactor",t.shadingShiftFactor),r.assignTexture("shadingShiftTexture",t.shadingShiftTexture,!0),r.assignPrimitive("shadingShiftTextureScale",(i=t.shadingShiftTexture)==null?void 0:i.scale),r.assignPrimitive("shadingToonyFactor",t.shadingToonyFactor),r.assignPrimitive("giEqualizationFactor",t.giEqualizationFactor),r.assignColor("matcapFactor",t.matcapFactor),r.assignTexture("matcapTexture",t.matcapTexture,!0),r.assignColor("parametricRimColorFactor",t.parametricRimColorFactor),r.assignTexture("rimMultiplyTexture",t.rimMultiplyTexture,!0),r.assignPrimitive("rimLightingMixFactor",t.rimLightingMixFactor),r.assignPrimitive("parametricRimFresnelPowerFactor",t.parametricRimFresnelPowerFactor),r.assignPrimitive("parametricRimLiftFactor",t.parametricRimLiftFactor),r.assignPrimitive("outlineWidthMode",t.outlineWidthMode),r.assignPrimitive("outlineWidthFactor",t.outlineWidthFactor),r.assignTexture("outlineWidthMultiplyTexture",t.outlineWidthMultiplyTexture,!1),r.assignColor("outlineColorFactor",t.outlineColorFactor),r.assignPrimitive("outlineLightingMixFactor",t.outlineLightingMixFactor),r.assignTexture("uvAnimationMaskTexture",t.uvAnimationMaskTexture,!1),r.assignPrimitive("uvAnimationScrollXSpeedFactor",t.uvAnimationScrollXSpeedFactor),r.assignPrimitive("uvAnimationScrollYSpeedFactor",t.uvAnimationScrollYSpeedFactor),r.assignPrimitive("uvAnimationRotationSpeedFactor",t.uvAnimationRotationSpeedFactor),r.assignPrimitive("v0CompatShade",this.v0CompatShade),r.assignPrimitive("debugMode",this.debugMode),yield r.pending})}_setupPrimitive(t,n){const i=this._getMToonExtension(n);if(i){const r=this._parseRenderOrder(i);t.renderOrder=r+this.renderOrderOffset,this._generateOutline(t),this._addToMaterialSet(t);return}}_shouldGenerateOutline(t){return typeof t.outlineWidthMode=="string"&&t.outlineWidthMode!=="none"&&typeof t.outlineWidthFactor=="number"&&t.outlineWidthFactor>0}_generateOutline(t){const n=t.material;if(!(n instanceof Ci)||!this._shouldGenerateOutline(n))return;t.material=[n];const i=n.clone();i.name+=" (Outline)",i.isOutline=!0,i.side=Ui,t.material.push(i);const r=t.geometry,o=r.index?r.index.count:r.attributes.position.count/3;r.addGroup(0,o,0),r.addGroup(0,o,1)}_addToMaterialSet(t){const n=t.material,i=new Set;Array.isArray(n)?n.forEach(r=>i.add(r)):i.add(n);for(const r of i)this._mToonMaterialSet.add(r)}_parseRenderOrder(t){var n;return(t.transparentWithZWrite?0:19)+((n=t.renderQueueOffsetNumber)!=null?n:0)}};Gn.EXTENSION_NAME="VRMC_materials_mtoon";var Sr=Gn,Er=(e,t,n)=>new Promise((i,r)=>{var o=a=>{try{l(n.next(a))}catch(u){r(u)}},s=a=>{try{l(n.throw(a))}catch(u){r(u)}},l=a=>a.done?i(a.value):Promise.resolve(a.value).then(o,s);l((n=n.apply(e,t)).next())}),Yn=class Je{get name(){return Je.EXTENSION_NAME}constructor(t){this.parser=t}extendMaterialParams(t,n){return Er(this,null,function*(){const i=this._getHDREmissiveMultiplierExtension(t);if(i==null)return;console.warn("VRMMaterialsHDREmissiveMultiplierLoaderPlugin: `VRMC_materials_hdr_emissiveMultiplier` is archived. Use `KHR_materials_emissive_strength` instead.");const r=i.emissiveMultiplier;n.emissiveIntensity=r})}_getHDREmissiveMultiplierExtension(t){var n,i;const s=(n=this.parser.json.materials)==null?void 0:n[t];if(s==null){console.warn(`VRMMaterialsHDREmissiveMultiplierLoaderPlugin: Attempt to use materials[${t}] of glTF but the material doesn't exist`);return}const l=(i=s.extensions)==null?void 0:i[Je.EXTENSION_NAME];if(l!=null)return l}};Yn.EXTENSION_NAME="VRMC_materials_hdr_emissiveMultiplier";var Ar=Yn,Pr=Object.defineProperty,Lr=Object.defineProperties,br=Object.getOwnPropertyDescriptors,fn=Object.getOwnPropertySymbols,Ir=Object.prototype.hasOwnProperty,Or=Object.prototype.propertyIsEnumerable,mn=(e,t,n)=>t in e?Pr(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n,F=(e,t)=>{for(var n in t||(t={}))Ir.call(t,n)&&mn(e,n,t[n]);if(fn)for(var n of fn(t))Or.call(t,n)&&mn(e,n,t[n]);return e},_n=(e,t)=>Lr(e,br(t)),Cr=(e,t,n)=>new Promise((i,r)=>{var o=a=>{try{l(n.next(a))}catch(u){r(u)}},s=a=>{try{l(n.throw(a))}catch(u){r(u)}},l=a=>a.done?i(a.value):Promise.resolve(a.value).then(o,s);l((n=n.apply(e,t)).next())});function ee(e){return Math.pow(e,2.2)}var Ur=class{get name(){return"VRMMaterialsV0CompatPlugin"}constructor(e){var t;this.parser=e,this._renderQueueMapTransparent=new Map,this._renderQueueMapTransparentZWrite=new Map;const n=this.parser.json;n.extensionsUsed=(t=n.extensionsUsed)!=null?t:[],n.extensionsUsed.indexOf("KHR_texture_transform")===-1&&n.extensionsUsed.push("KHR_texture_transform")}beforeRoot(){return Cr(this,null,function*(){var e;const t=this.parser.json,n=(e=t.extensions)==null?void 0:e.VRM,i=n?.materialProperties;i&&(this._populateRenderQueueMap(i),i.forEach((r,o)=>{var s,l;const a=(s=t.materials)==null?void 0:s[o];if(a==null){console.warn(`VRMMaterialsV0CompatPlugin: Attempt to use materials[${o}] of glTF but the material doesn't exist`);return}if(r.shader==="VRM/MToon"){const u=this._parseV0MToonProperties(r,a);t.materials[o]=u}else if((l=r.shader)!=null&&l.startsWith("VRM/Unlit")){const u=this._parseV0UnlitProperties(r,a);t.materials[o]=u}else r.shader==="VRM_USE_GLTFSHADER"||console.warn(`VRMMaterialsV0CompatPlugin: Unknown shader: ${r.shader}`)}))})}_parseV0MToonProperties(e,t){var n,i,r,o,s,l,a,u,h,d,c,p,m,f,_,v,R,w,y,M,x,T,A,b,P,L,O,X,se,ae,W,D,J,le,U,st,at,lt,ut,dt,ht,ct,pt,ft,mt,_t,gt,vt,Mt,xt,yt,Rt,wt,Tt,St;const Et=(i=(n=e.keywordMap)==null?void 0:n._ALPHABLEND_ON)!=null?i:!1,ei=((r=e.floatProperties)==null?void 0:r._ZWrite)===1&&Et,ti=this._v0ParseRenderQueue(e),At=(s=(o=e.keywordMap)==null?void 0:o._ALPHATEST_ON)!=null?s:!1,ni=Et?"BLEND":At?"MASK":"OPAQUE",ii=At?(a=(l=e.floatProperties)==null?void 0:l._Cutoff)!=null?a:.5:void 0,ri=((h=(u=e.floatProperties)==null?void 0:u._CullMode)!=null?h:2)===0,Y=this._portTextureTransform(e),oi=((c=(d=e.vectorProperties)==null?void 0:d._Color)!=null?c:[1,1,1,1]).map((Vt,Li)=>Li===3?Vt:ee(Vt)),Pt=(p=e.textureProperties)==null?void 0:p._MainTex,si=Pt!=null?{index:Pt,extensions:F({},Y)}:void 0,ai=(f=(m=e.floatProperties)==null?void 0:m._BumpScale)!=null?f:1,Lt=(_=e.textureProperties)==null?void 0:_._BumpMap,li=Lt!=null?{index:Lt,scale:ai,extensions:F({},Y)}:void 0,ui=((R=(v=e.vectorProperties)==null?void 0:v._EmissionColor)!=null?R:[0,0,0,1]).map(ee),bt=(w=e.textureProperties)==null?void 0:w._EmissionMap,di=bt!=null?{index:bt,extensions:F({},Y)}:void 0,hi=((M=(y=e.vectorProperties)==null?void 0:y._ShadeColor)!=null?M:[.97,.81,.86,1]).map(ee),It=(x=e.textureProperties)==null?void 0:x._ShadeTexture,ci=It!=null?{index:It,extensions:F({},Y)}:void 0;let ge=(A=(T=e.floatProperties)==null?void 0:T._ShadeShift)!=null?A:0,ve=(P=(b=e.floatProperties)==null?void 0:b._ShadeToony)!=null?P:.9;ve=I.lerp(ve,1,.5+.5*ge),ge=-ge-(1-ve);const Ot=(O=(L=e.floatProperties)==null?void 0:L._IndirectLightIntensity)!=null?O:.1,pi=Ot?1-Ot:void 0,Ue=(X=e.textureProperties)==null?void 0:X._SphereAdd,fi=Ue!=null?[1,1,1]:void 0,mi=Ue!=null?{index:Ue}:void 0,_i=(ae=(se=e.floatProperties)==null?void 0:se._RimLightingMix)!=null?ae:0,Ct=(W=e.textureProperties)==null?void 0:W._RimTexture,gi=Ct!=null?{index:Ct,extensions:F({},Y)}:void 0,vi=((J=(D=e.vectorProperties)==null?void 0:D._RimColor)!=null?J:[0,0,0,1]).map(ee),Mi=(U=(le=e.floatProperties)==null?void 0:le._RimFresnelPower)!=null?U:1,xi=(at=(st=e.floatProperties)==null?void 0:st._RimLift)!=null?at:0,yi=["none","worldCoordinates","screenCoordinates"][(ut=(lt=e.floatProperties)==null?void 0:lt._OutlineWidthMode)!=null?ut:0];let Ne=(ht=(dt=e.floatProperties)==null?void 0:dt._OutlineWidth)!=null?ht:0;Ne=.01*Ne;const Ut=(ct=e.textureProperties)==null?void 0:ct._OutlineWidthTexture,Ri=Ut!=null?{index:Ut,extensions:F({},Y)}:void 0,wi=((ft=(pt=e.vectorProperties)==null?void 0:pt._OutlineColor)!=null?ft:[0,0,0]).map(ee),Ti=((_t=(mt=e.floatProperties)==null?void 0:mt._OutlineColorMode)!=null?_t:0)===1?(vt=(gt=e.floatProperties)==null?void 0:gt._OutlineLightingMix)!=null?vt:1:0,Nt=(Mt=e.textureProperties)==null?void 0:Mt._UvAnimMaskTexture,Si=Nt!=null?{index:Nt,extensions:F({},Y)}:void 0,Ei=(yt=(xt=e.floatProperties)==null?void 0:xt._UvAnimScrollX)!=null?yt:0;let Me=(wt=(Rt=e.floatProperties)==null?void 0:Rt._UvAnimScrollY)!=null?wt:0;Me!=null&&(Me=-Me);const Ai=(St=(Tt=e.floatProperties)==null?void 0:Tt._UvAnimRotation)!=null?St:0,Pi={specVersion:"1.0",transparentWithZWrite:ei,renderQueueOffsetNumber:ti,shadeColorFactor:hi,shadeMultiplyTexture:ci,shadingShiftFactor:ge,shadingToonyFactor:ve,giEqualizationFactor:pi,matcapFactor:fi,matcapTexture:mi,rimLightingMixFactor:_i,rimMultiplyTexture:gi,parametricRimColorFactor:vi,parametricRimFresnelPowerFactor:Mi,parametricRimLiftFactor:xi,outlineWidthMode:yi,outlineWidthFactor:Ne,outlineWidthMultiplyTexture:Ri,outlineColorFactor:wi,outlineLightingMixFactor:Ti,uvAnimationMaskTexture:Si,uvAnimationScrollXSpeedFactor:Ei,uvAnimationScrollYSpeedFactor:Me,uvAnimationRotationSpeedFactor:Ai};return _n(F({},t),{pbrMetallicRoughness:{baseColorFactor:oi,baseColorTexture:si},normalTexture:li,emissiveTexture:di,emissiveFactor:ui,alphaMode:ni,alphaCutoff:ii,doubleSided:ri,extensions:{VRMC_materials_mtoon:Pi}})}_parseV0UnlitProperties(e,t){var n,i,r,o,s;const l=e.shader==="VRM/UnlitTransparentZWrite",a=e.shader==="VRM/UnlitTransparent"||l,u=this._v0ParseRenderQueue(e),h=e.shader==="VRM/UnlitCutout",d=a?"BLEND":h?"MASK":"OPAQUE",c=h?(i=(n=e.floatProperties)==null?void 0:n._Cutoff)!=null?i:.5:void 0,p=this._portTextureTransform(e),m=((o=(r=e.vectorProperties)==null?void 0:r._Color)!=null?o:[1,1,1,1]).map(ee),f=(s=e.textureProperties)==null?void 0:s._MainTex,_=f!=null?{index:f,extensions:F({},p)}:void 0,v={specVersion:"1.0",transparentWithZWrite:l,renderQueueOffsetNumber:u,shadeColorFactor:m,shadeMultiplyTexture:_};return _n(F({},t),{pbrMetallicRoughness:{baseColorFactor:m,baseColorTexture:_},alphaMode:d,alphaCutoff:c,extensions:{VRMC_materials_mtoon:v}})}_portTextureTransform(e){var t,n,i,r,o;const s=(t=e.vectorProperties)==null?void 0:t._MainTex;if(s==null)return{};const l=[(n=s?.[0])!=null?n:0,(i=s?.[1])!=null?i:0],a=[(r=s?.[2])!=null?r:1,(o=s?.[3])!=null?o:1];return l[1]=1-a[1]-l[1],{KHR_texture_transform:{offset:l,scale:a}}}_v0ParseRenderQueue(e){var t,n;const i=e.shader==="VRM/UnlitTransparentZWrite",r=((t=e.keywordMap)==null?void 0:t._ALPHABLEND_ON)!=null||e.shader==="VRM/UnlitTransparent"||i,o=((n=e.floatProperties)==null?void 0:n._ZWrite)===1||i;let s=0;if(r){const l=e.renderQueue;l!=null&&(o?s=this._renderQueueMapTransparentZWrite.get(l):s=this._renderQueueMapTransparent.get(l))}return s}_populateRenderQueueMap(e){const t=new Set,n=new Set;e.forEach(i=>{var r,o;const s=i.shader==="VRM/UnlitTransparentZWrite",l=((r=i.keywordMap)==null?void 0:r._ALPHABLEND_ON)!=null||i.shader==="VRM/UnlitTransparent"||s,a=((o=i.floatProperties)==null?void 0:o._ZWrite)===1||s;if(l){const u=i.renderQueue;u!=null&&(a?n.add(u):t.add(u))}}),t.size>10&&console.warn(`VRMMaterialsV0CompatPlugin: This VRM uses ${t.size} render queues for Transparent materials while VRM 1.0 only supports up to 10 render queues. The model might not be rendered correctly.`),n.size>10&&console.warn(`VRMMaterialsV0CompatPlugin: This VRM uses ${n.size} render queues for TransparentZWrite materials while VRM 1.0 only supports up to 10 render queues. The model might not be rendered correctly.`),Array.from(t).sort().forEach((i,r)=>{const o=Math.min(Math.max(r-t.size+1,-9),0);this._renderQueueMapTransparent.set(i,o)}),Array.from(n).sort().forEach((i,r)=>{const o=Math.min(Math.max(r,0),9);this._renderQueueMapTransparentZWrite.set(i,o)})}},gn=(e,t,n)=>new Promise((i,r)=>{var o=a=>{try{l(n.next(a))}catch(u){r(u)}},s=a=>{try{l(n.throw(a))}catch(u){r(u)}},l=a=>a.done?i(a.value):Promise.resolve(a.value).then(o,s);l((n=n.apply(e,t)).next())}),G=new g,ke=class extends re{constructor(e){super(),this._attrPosition=new C(new Float32Array([0,0,0,0,0,0]),3),this._attrPosition.setUsage(Di);const t=new j;t.setAttribute("position",this._attrPosition);const n=new Ce({color:16711935,depthTest:!1,depthWrite:!1});this._line=new Bi(t,n),this.add(this._line),this.constraint=e}updateMatrixWorld(e){G.setFromMatrixPosition(this.constraint.destination.matrixWorld),this._attrPosition.setXYZ(0,G.x,G.y,G.z),this.constraint.source&&G.setFromMatrixPosition(this.constraint.source.matrixWorld),this._attrPosition.setXYZ(1,G.x,G.y,G.z),this._attrPosition.needsUpdate=!0,super.updateMatrixWorld(e)}};function vn(e,t){return t.set(e.elements[12],e.elements[13],e.elements[14])}var Nr=new g,Vr=new g;function Dr(e,t){return e.decompose(Nr,t,Vr),t}function be(e){return e.invert?e.invert():e.inverse(),e}var rt=class{constructor(e,t){this.destination=e,this.source=t,this.weight=1}},Br=new g,Fr=new g,Hr=new g,kr=new E,Wr=new E,zr=new E,jr=class extends rt{get aimAxis(){return this._aimAxis}set aimAxis(e){this._aimAxis=e,this._v3AimAxis.set(e==="PositiveX"?1:e==="NegativeX"?-1:0,e==="PositiveY"?1:e==="NegativeY"?-1:0,e==="PositiveZ"?1:e==="NegativeZ"?-1:0)}get dependencies(){const e=new Set([this.source]);return this.destination.parent&&e.add(this.destination.parent),e}constructor(e,t){super(e,t),this._aimAxis="PositiveX",this._v3AimAxis=new g(1,0,0),this._dstRestQuat=new E}setInitState(){this._dstRestQuat.copy(this.destination.quaternion)}update(){this.destination.updateWorldMatrix(!0,!1),this.source.updateWorldMatrix(!0,!1);const e=kr.identity(),t=Wr.identity();this.destination.parent&&(Dr(this.destination.parent.matrixWorld,e),be(t.copy(e)));const n=Br.copy(this._v3AimAxis).applyQuaternion(this._dstRestQuat).applyQuaternion(e),i=vn(this.source.matrixWorld,Fr).sub(vn(this.destination.matrixWorld,Hr)).normalize(),r=zr.setFromUnitVectors(n,i).premultiply(t).multiply(e).multiply(this._dstRestQuat);this.destination.quaternion.copy(this._dstRestQuat).slerp(r,this.weight)}};function Xr(e,t){const n=[e];let i=e.parent;for(;i!==null;)n.unshift(i),i=i.parent;n.forEach(r=>{t(r)})}var Gr=class{constructor(){this._constraints=new Set,this._objectConstraintsMap=new Map}get constraints(){return this._constraints}addConstraint(e){this._constraints.add(e);let t=this._objectConstraintsMap.get(e.destination);t==null&&(t=new Set,this._objectConstraintsMap.set(e.destination,t)),t.add(e)}deleteConstraint(e){this._constraints.delete(e),this._objectConstraintsMap.get(e.destination).delete(e)}setInitState(){const e=new Set,t=new Set;for(const n of this._constraints)this._processConstraint(n,e,t,i=>i.setInitState())}update(){const e=new Set,t=new Set;for(const n of this._constraints)this._processConstraint(n,e,t,i=>i.update())}_processConstraint(e,t,n,i){if(n.has(e))return;if(t.has(e))throw new Error("VRMNodeConstraintManager: Circular dependency detected while updating constraints");t.add(e);const r=e.dependencies;for(const o of r)Xr(o,s=>{const l=this._objectConstraintsMap.get(s);if(l)for(const a of l)this._processConstraint(a,t,n,i)});i(e),n.add(e)}},Yr=new E,qr=new E,Qr=class extends rt{get dependencies(){return new Set([this.source])}constructor(e,t){super(e,t),this._dstRestQuat=new E,this._invSrcRestQuat=new E}setInitState(){this._dstRestQuat.copy(this.destination.quaternion),be(this._invSrcRestQuat.copy(this.source.quaternion))}update(){const e=Yr.copy(this._invSrcRestQuat).multiply(this.source.quaternion),t=qr.copy(this._dstRestQuat).multiply(e);this.destination.quaternion.copy(this._dstRestQuat).slerp(t,this.weight)}},$r=new g,Zr=new E,Jr=new E,Kr=class extends rt{get rollAxis(){return this._rollAxis}set rollAxis(e){this._rollAxis=e,this._v3RollAxis.set(e==="X"?1:0,e==="Y"?1:0,e==="Z"?1:0)}get dependencies(){return new Set([this.source])}constructor(e,t){super(e,t),this._rollAxis="X",this._v3RollAxis=new g(1,0,0),this._dstRestQuat=new E,this._invDstRestQuat=new E,this._invSrcRestQuatMulDstRestQuat=new E}setInitState(){this._dstRestQuat.copy(this.destination.quaternion),be(this._invDstRestQuat.copy(this._dstRestQuat)),be(this._invSrcRestQuatMulDstRestQuat.copy(this.source.quaternion)).multiply(this._dstRestQuat)}update(){const e=Zr.copy(this._invDstRestQuat).multiply(this.source.quaternion).multiply(this._invSrcRestQuatMulDstRestQuat),t=$r.copy(this._v3RollAxis).applyQuaternion(e),i=Jr.setFromUnitVectors(t,this._v3RollAxis).premultiply(this._dstRestQuat).multiply(e);this.destination.quaternion.copy(this._dstRestQuat).slerp(i,this.weight)}},eo=new Set(["1.0","1.0-beta"]),qn=class _e{get name(){return _e.EXTENSION_NAME}constructor(t,n){this.parser=t,this.helperRoot=n?.helperRoot}afterRoot(t){return gn(this,null,function*(){t.userData.vrmNodeConstraintManager=yield this._import(t)})}_import(t){return gn(this,null,function*(){var n;const i=this.parser.json;if(!(((n=i.extensionsUsed)==null?void 0:n.indexOf(_e.EXTENSION_NAME))!==-1))return null;const o=new Gr,s=yield this.parser.getDependencies("node");return s.forEach((l,a)=>{var u;const h=i.nodes[a],d=(u=h?.extensions)==null?void 0:u[_e.EXTENSION_NAME];if(d==null)return;const c=d.specVersion;if(!eo.has(c)){console.warn(`VRMNodeConstraintLoaderPlugin: Unknown ${_e.EXTENSION_NAME} specVersion "${c}"`);return}const p=d.constraint;if(p.roll!=null){const m=this._importRollConstraint(l,s,p.roll);o.addConstraint(m)}else if(p.aim!=null){const m=this._importAimConstraint(l,s,p.aim);o.addConstraint(m)}else if(p.rotation!=null){const m=this._importRotationConstraint(l,s,p.rotation);o.addConstraint(m)}}),t.scene.updateMatrixWorld(),o.setInitState(),o})}_importRollConstraint(t,n,i){const{source:r,rollAxis:o,weight:s}=i,l=n[r],a=new Kr(t,l);if(o!=null&&(a.rollAxis=o),s!=null&&(a.weight=s),this.helperRoot){const u=new ke(a);this.helperRoot.add(u)}return a}_importAimConstraint(t,n,i){const{source:r,aimAxis:o,weight:s}=i,l=n[r],a=new jr(t,l);if(o!=null&&(a.aimAxis=o),s!=null&&(a.weight=s),this.helperRoot){const u=new ke(a);this.helperRoot.add(u)}return a}_importRotationConstraint(t,n,i){const{source:r,weight:o}=i,s=n[r],l=new Qr(t,s);if(o!=null&&(l.weight=o),this.helperRoot){const a=new ke(l);this.helperRoot.add(a)}return l}};qn.EXTENSION_NAME="VRMC_node_constraint";var to=qn,we=(e,t,n)=>new Promise((i,r)=>{var o=a=>{try{l(n.next(a))}catch(u){r(u)}},s=a=>{try{l(n.throw(a))}catch(u){r(u)}},l=a=>a.done?i(a.value):Promise.resolve(a.value).then(o,s);l((n=n.apply(e,t)).next())}),ot=class{},We=new g,$=new g,Qn=class extends ot{get type(){return"capsule"}constructor(e){var t,n,i,r;super(),this.offset=(t=e?.offset)!=null?t:new g(0,0,0),this.tail=(n=e?.tail)!=null?n:new g(0,0,0),this.radius=(i=e?.radius)!=null?i:0,this.inside=(r=e?.inside)!=null?r:!1}calculateCollision(e,t,n,i){We.setFromMatrixPosition(e),$.subVectors(this.tail,this.offset).applyMatrix4(e),$.sub(We);const r=$.lengthSq();i.copy(t).sub(We);const o=$.dot(i);o<=0||(r<=o||$.multiplyScalar(o/r),i.sub($));const s=i.length(),l=this.inside?this.radius-n-s:s-n-this.radius;return l<0&&(i.multiplyScalar(1/s),this.inside&&i.negate()),l}},ze=new g,Mn=new k,$n=class extends ot{get type(){return"plane"}constructor(e){var t,n;super(),this.offset=(t=e?.offset)!=null?t:new g(0,0,0),this.normal=(n=e?.normal)!=null?n:new g(0,0,1)}calculateCollision(e,t,n,i){i.setFromMatrixPosition(e),i.negate().add(t),Mn.getNormalMatrix(e),ze.copy(this.normal).applyNormalMatrix(Mn).normalize();const r=i.dot(ze)-n;return i.copy(ze),r}},no=new g,Zn=class extends ot{get type(){return"sphere"}constructor(e){var t,n,i;super(),this.offset=(t=e?.offset)!=null?t:new g(0,0,0),this.radius=(n=e?.radius)!=null?n:0,this.inside=(i=e?.inside)!=null?i:!1}calculateCollision(e,t,n,i){i.subVectors(t,no.setFromMatrixPosition(e));const r=i.length(),o=this.inside?this.radius-n-r:r-n-this.radius;return o<0&&(i.multiplyScalar(1/r),this.inside&&i.negate()),o}},H=new g,io=class extends j{constructor(e){super(),this.worldScale=1,this._currentRadius=0,this._currentOffset=new g,this._currentTail=new g,this._shape=e,this._attrPos=new C(new Float32Array(396),3),this.setAttribute("position",this._attrPos),this._attrIndex=new C(new Uint16Array(264),1),this.setIndex(this._attrIndex),this._buildIndex(),this.update()}update(){let e=!1;const t=this._shape.radius/this.worldScale;this._currentRadius!==t&&(this._currentRadius=t,e=!0),this._currentOffset.equals(this._shape.offset)||(this._currentOffset.copy(this._shape.offset),e=!0);const n=H.copy(this._shape.tail).divideScalar(this.worldScale);this._currentTail.distanceToSquared(n)>1e-10&&(this._currentTail.copy(n),e=!0),e&&this._buildPosition()}_buildPosition(){H.copy(this._currentTail).sub(this._currentOffset);const e=H.length()/this._currentRadius;for(let i=0;i<=16;i++){const r=i/16*Math.PI;this._attrPos.setXYZ(i,-Math.sin(r),-Math.cos(r),0),this._attrPos.setXYZ(17+i,e+Math.sin(r),Math.cos(r),0),this._attrPos.setXYZ(34+i,-Math.sin(r),0,-Math.cos(r)),this._attrPos.setXYZ(51+i,e+Math.sin(r),0,Math.cos(r))}for(let i=0;i<32;i++){const r=i/16*Math.PI;this._attrPos.setXYZ(68+i,0,Math.sin(r),Math.cos(r)),this._attrPos.setXYZ(100+i,e,Math.sin(r),Math.cos(r))}const t=Math.atan2(H.y,Math.sqrt(H.x*H.x+H.z*H.z)),n=-Math.atan2(H.z,H.x);this.rotateZ(t),this.rotateY(n),this.scale(this._currentRadius,this._currentRadius,this._currentRadius),this.translate(this._currentOffset.x,this._currentOffset.y,this._currentOffset.z),this._attrPos.needsUpdate=!0}_buildIndex(){for(let e=0;e<34;e++){const t=(e+1)%34;this._attrIndex.setXY(e*2,e,t),this._attrIndex.setXY(68+e*2,34+e,34+t)}for(let e=0;e<32;e++){const t=(e+1)%32;this._attrIndex.setXY(136+e*2,68+e,68+t),this._attrIndex.setXY(200+e*2,100+e,100+t)}this._attrIndex.needsUpdate=!0}},ro=class extends j{constructor(e){super(),this.worldScale=1,this._currentOffset=new g,this._currentNormal=new g,this._shape=e,this._attrPos=new C(new Float32Array(18),3),this.setAttribute("position",this._attrPos),this._attrIndex=new C(new Uint16Array(10),1),this.setIndex(this._attrIndex),this._buildIndex(),this.update()}update(){let e=!1;this._currentOffset.equals(this._shape.offset)||(this._currentOffset.copy(this._shape.offset),e=!0),this._currentNormal.equals(this._shape.normal)||(this._currentNormal.copy(this._shape.normal),e=!0),e&&this._buildPosition()}_buildPosition(){this._attrPos.setXYZ(0,-.5,-.5,0),this._attrPos.setXYZ(1,.5,-.5,0),this._attrPos.setXYZ(2,.5,.5,0),this._attrPos.setXYZ(3,-.5,.5,0),this._attrPos.setXYZ(4,0,0,0),this._attrPos.setXYZ(5,0,0,.25),this.translate(this._currentOffset.x,this._currentOffset.y,this._currentOffset.z),this.lookAt(this._currentNormal),this._attrPos.needsUpdate=!0}_buildIndex(){this._attrIndex.setXY(0,0,1),this._attrIndex.setXY(2,1,2),this._attrIndex.setXY(4,2,3),this._attrIndex.setXY(6,3,0),this._attrIndex.setXY(8,4,5),this._attrIndex.needsUpdate=!0}},oo=class extends j{constructor(e){super(),this.worldScale=1,this._currentRadius=0,this._currentOffset=new g,this._shape=e,this._attrPos=new C(new Float32Array(288),3),this.setAttribute("position",this._attrPos),this._attrIndex=new C(new Uint16Array(192),1),this.setIndex(this._attrIndex),this._buildIndex(),this.update()}update(){let e=!1;const t=this._shape.radius/this.worldScale;this._currentRadius!==t&&(this._currentRadius=t,e=!0),this._currentOffset.equals(this._shape.offset)||(this._currentOffset.copy(this._shape.offset),e=!0),e&&this._buildPosition()}_buildPosition(){for(let e=0;e<32;e++){const t=e/16*Math.PI;this._attrPos.setXYZ(e,Math.cos(t),Math.sin(t),0),this._attrPos.setXYZ(32+e,0,Math.cos(t),Math.sin(t)),this._attrPos.setXYZ(64+e,Math.sin(t),0,Math.cos(t))}this.scale(this._currentRadius,this._currentRadius,this._currentRadius),this.translate(this._currentOffset.x,this._currentOffset.y,this._currentOffset.z),this._attrPos.needsUpdate=!0}_buildIndex(){for(let e=0;e<32;e++){const t=(e+1)%32;this._attrIndex.setXY(e*2,e,t),this._attrIndex.setXY(64+e*2,32+e,32+t),this._attrIndex.setXY(128+e*2,64+e,64+t)}this._attrIndex.needsUpdate=!0}},so=new g,je=class extends re{constructor(e){if(super(),this.matrixAutoUpdate=!1,this.collider=e,this.collider.shape instanceof Zn)this._geometry=new oo(this.collider.shape);else if(this.collider.shape instanceof Qn)this._geometry=new io(this.collider.shape);else if(this.collider.shape instanceof $n)this._geometry=new ro(this.collider.shape);else throw new Error("VRMSpringBoneColliderHelper: Unknown collider shape type detected");const t=new Ce({color:16711935,depthTest:!1,depthWrite:!1});this._line=new nt(this._geometry,t),this.add(this._line)}dispose(){this._geometry.dispose()}updateMatrixWorld(e){this.collider.updateWorldMatrix(!0,!1),this.matrix.copy(this.collider.matrixWorld);const t=this.matrix.elements;this._geometry.worldScale=so.set(t[0],t[1],t[2]).length(),this._geometry.update(),super.updateMatrixWorld(e)}},ao=class extends j{constructor(e){super(),this.worldScale=1,this._currentRadius=0,this._currentTail=new g,this._springBone=e,this._attrPos=new C(new Float32Array(294),3),this.setAttribute("position",this._attrPos),this._attrIndex=new C(new Uint16Array(194),1),this.setIndex(this._attrIndex),this._buildIndex(),this.update()}update(){let e=!1;const t=this._springBone.settings.hitRadius/this.worldScale;this._currentRadius!==t&&(this._currentRadius=t,e=!0),this._currentTail.equals(this._springBone.initialLocalChildPosition)||(this._currentTail.copy(this._springBone.initialLocalChildPosition),e=!0),e&&this._buildPosition()}_buildPosition(){for(let e=0;e<32;e++){const t=e/16*Math.PI;this._attrPos.setXYZ(e,Math.cos(t),Math.sin(t),0),this._attrPos.setXYZ(32+e,0,Math.cos(t),Math.sin(t)),this._attrPos.setXYZ(64+e,Math.sin(t),0,Math.cos(t))}this.scale(this._currentRadius,this._currentRadius,this._currentRadius),this.translate(this._currentTail.x,this._currentTail.y,this._currentTail.z),this._attrPos.setXYZ(96,0,0,0),this._attrPos.setXYZ(97,this._currentTail.x,this._currentTail.y,this._currentTail.z),this._attrPos.needsUpdate=!0}_buildIndex(){for(let e=0;e<32;e++){const t=(e+1)%32;this._attrIndex.setXY(e*2,e,t),this._attrIndex.setXY(64+e*2,32+e,32+t),this._attrIndex.setXY(128+e*2,64+e,64+t)}this._attrIndex.setXY(192,96,97),this._attrIndex.needsUpdate=!0}},lo=new g,uo=class extends re{constructor(e){super(),this.matrixAutoUpdate=!1,this.springBone=e,this._geometry=new ao(this.springBone);const t=new Ce({color:16776960,depthTest:!1,depthWrite:!1});this._line=new nt(this._geometry,t),this.add(this._line)}dispose(){this._geometry.dispose()}updateMatrixWorld(e){this.springBone.bone.updateWorldMatrix(!0,!1),this.matrix.copy(this.springBone.bone.matrixWorld);const t=this.matrix.elements;this._geometry.worldScale=lo.set(t[0],t[1],t[2]).length(),this._geometry.update(),super.updateMatrixWorld(e)}},Xe=class extends Ae{constructor(e){super(),this.colliderMatrix=new z,this.shape=e}updateWorldMatrix(e,t){super.updateWorldMatrix(e,t),ho(this.colliderMatrix,this.matrixWorld,this.shape.offset)}};function ho(e,t,n){const i=t.elements;e.copy(t),n&&(e.elements[12]=i[0]*n.x+i[4]*n.y+i[8]*n.z+i[12],e.elements[13]=i[1]*n.x+i[5]*n.y+i[9]*n.z+i[13],e.elements[14]=i[2]*n.x+i[6]*n.y+i[10]*n.z+i[14])}var co=new z;function po(e){return e.invert?e.invert():e.getInverse(co.copy(e)),e}var fo=class{constructor(e){this._inverseCache=new z,this._shouldUpdateInverse=!0,this.matrix=e;const t={set:(n,i,r)=>(this._shouldUpdateInverse=!0,n[i]=r,!0)};this._originalElements=e.elements,e.elements=new Proxy(e.elements,t)}get inverse(){return this._shouldUpdateInverse&&(po(this._inverseCache.copy(this.matrix)),this._shouldUpdateInverse=!1),this._inverseCache}revert(){this.matrix.elements=this._originalElements}},Ge=new z,te=new g,ce=new g,pe=new g,fe=new g,mo=new z,_o=class{constructor(e,t,n={},i=[]){this._currentTail=new g,this._prevTail=new g,this._boneAxis=new g,this._worldSpaceBoneLength=0,this._center=null,this._initialLocalMatrix=new z,this._initialLocalRotation=new E,this._initialLocalChildPosition=new g;var r,o,s,l,a,u;this.bone=e,this.bone.matrixAutoUpdate=!1,this.child=t,this.settings={hitRadius:(r=n.hitRadius)!=null?r:0,stiffness:(o=n.stiffness)!=null?o:1,gravityPower:(s=n.gravityPower)!=null?s:0,gravityDir:(a=(l=n.gravityDir)==null?void 0:l.clone())!=null?a:new g(0,-1,0),dragForce:(u=n.dragForce)!=null?u:.4},this.colliderGroups=i}get dependencies(){const e=new Set,t=this.bone.parent;t&&e.add(t);for(let n=0;n<this.colliderGroups.length;n++)for(let i=0;i<this.colliderGroups[n].colliders.length;i++)e.add(this.colliderGroups[n].colliders[i]);return e}get center(){return this._center}set center(e){var t;(t=this._center)!=null&&t.userData.inverseCacheProxy&&(this._center.userData.inverseCacheProxy.revert(),delete this._center.userData.inverseCacheProxy),this._center=e,this._center&&(this._center.userData.inverseCacheProxy||(this._center.userData.inverseCacheProxy=new fo(this._center.matrixWorld)))}get initialLocalChildPosition(){return this._initialLocalChildPosition}get _parentMatrixWorld(){return this.bone.parent?this.bone.parent.matrixWorld:Ge}setInitState(){this._initialLocalMatrix.copy(this.bone.matrix),this._initialLocalRotation.copy(this.bone.quaternion),this.child?this._initialLocalChildPosition.copy(this.child.position):this._initialLocalChildPosition.copy(this.bone.position).normalize().multiplyScalar(.07);const e=this._getMatrixWorldToCenter();this.bone.localToWorld(this._currentTail.copy(this._initialLocalChildPosition)).applyMatrix4(e),this._prevTail.copy(this._currentTail),this._boneAxis.copy(this._initialLocalChildPosition).normalize()}reset(){this.bone.quaternion.copy(this._initialLocalRotation),this.bone.updateMatrix(),this.bone.matrixWorld.multiplyMatrices(this._parentMatrixWorld,this.bone.matrix);const e=this._getMatrixWorldToCenter();this.bone.localToWorld(this._currentTail.copy(this._initialLocalChildPosition)).applyMatrix4(e),this._prevTail.copy(this._currentTail)}update(e){if(e<=0)return;this._calcWorldSpaceBoneLength();const t=ce.copy(this._boneAxis).transformDirection(this._initialLocalMatrix).transformDirection(this._parentMatrixWorld);fe.copy(this._currentTail).add(te.subVectors(this._currentTail,this._prevTail).multiplyScalar(1-this.settings.dragForce)).applyMatrix4(this._getMatrixCenterToWorld()).addScaledVector(t,this.settings.stiffness*e).addScaledVector(this.settings.gravityDir,this.settings.gravityPower*e),pe.setFromMatrixPosition(this.bone.matrixWorld),fe.sub(pe).normalize().multiplyScalar(this._worldSpaceBoneLength).add(pe),this._collision(fe),this._prevTail.copy(this._currentTail),this._currentTail.copy(fe).applyMatrix4(this._getMatrixWorldToCenter());const n=mo.multiplyMatrices(this._parentMatrixWorld,this._initialLocalMatrix).invert();this.bone.quaternion.setFromUnitVectors(this._boneAxis,te.copy(fe).applyMatrix4(n).normalize()).premultiply(this._initialLocalRotation),this.bone.updateMatrix(),this.bone.matrixWorld.multiplyMatrices(this._parentMatrixWorld,this.bone.matrix)}_collision(e){for(let t=0;t<this.colliderGroups.length;t++)for(let n=0;n<this.colliderGroups[t].colliders.length;n++){const i=this.colliderGroups[t].colliders[n],r=i.shape.calculateCollision(i.colliderMatrix,e,this.settings.hitRadius,te);if(r<0){e.addScaledVector(te,-r),e.sub(pe);const o=e.length();e.multiplyScalar(this._worldSpaceBoneLength/o).add(pe)}}}_calcWorldSpaceBoneLength(){te.setFromMatrixPosition(this.bone.matrixWorld),this.child?ce.setFromMatrixPosition(this.child.matrixWorld):(ce.copy(this._initialLocalChildPosition),ce.applyMatrix4(this.bone.matrixWorld)),this._worldSpaceBoneLength=te.sub(ce).length()}_getMatrixCenterToWorld(){return this._center?this._center.matrixWorld:Ge}_getMatrixWorldToCenter(){return this._center?this._center.userData.inverseCacheProxy.inverse:Ge}};function go(e,t){const n=[];let i=e;for(;i!==null;)n.unshift(i),i=i.parent;n.forEach(r=>{t(r)})}function Ke(e,t){e.children.forEach(n=>{t(n)||Ke(n,t)})}function vo(e){var t;const n=new Map;for(const i of e){let r=i;do{const o=((t=n.get(r))!=null?t:0)+1;if(o===e.size)return r;n.set(r,o),r=r.parent}while(r!==null)}return null}var xn=class{constructor(){this._joints=new Set,this._sortedJoints=[],this._hasWarnedCircularDependency=!1,this._ancestors=[],this._objectSpringBonesMap=new Map,this._isSortedJointsDirty=!1,this._relevantChildrenUpdated=this._relevantChildrenUpdated.bind(this)}get joints(){return this._joints}get springBones(){return console.warn("VRMSpringBoneManager: springBones is deprecated. use joints instead."),this._joints}get colliderGroups(){const e=new Set;return this._joints.forEach(t=>{t.colliderGroups.forEach(n=>{e.add(n)})}),Array.from(e)}get colliders(){const e=new Set;return this.colliderGroups.forEach(t=>{t.colliders.forEach(n=>{e.add(n)})}),Array.from(e)}addJoint(e){this._joints.add(e);let t=this._objectSpringBonesMap.get(e.bone);t==null&&(t=new Set,this._objectSpringBonesMap.set(e.bone,t)),t.add(e),this._isSortedJointsDirty=!0}addSpringBone(e){console.warn("VRMSpringBoneManager: addSpringBone() is deprecated. use addJoint() instead."),this.addJoint(e)}deleteJoint(e){this._joints.delete(e),this._objectSpringBonesMap.get(e.bone).delete(e),this._isSortedJointsDirty=!0}deleteSpringBone(e){console.warn("VRMSpringBoneManager: deleteSpringBone() is deprecated. use deleteJoint() instead."),this.deleteJoint(e)}setInitState(){this._sortJoints();for(let e=0;e<this._sortedJoints.length;e++){const t=this._sortedJoints[e];t.bone.updateMatrix(),t.bone.updateWorldMatrix(!1,!1),t.setInitState()}}reset(){this._sortJoints();for(let e=0;e<this._sortedJoints.length;e++){const t=this._sortedJoints[e];t.bone.updateMatrix(),t.bone.updateWorldMatrix(!1,!1),t.reset()}}update(e){this._sortJoints();for(let t=0;t<this._ancestors.length;t++)this._ancestors[t].updateWorldMatrix(t===0,!1);for(let t=0;t<this._sortedJoints.length;t++){const n=this._sortedJoints[t];n.bone.updateMatrix(),n.bone.updateWorldMatrix(!1,!1),n.update(e),Ke(n.bone,this._relevantChildrenUpdated)}}_sortJoints(){if(!this._isSortedJointsDirty)return;const e=[],t=new Set,n=new Set,i=new Set;for(const o of this._joints)this._insertJointSort(o,t,n,e,i);this._sortedJoints=e;const r=vo(i);this._ancestors=[],r&&(this._ancestors.push(r),Ke(r,o=>{var s,l;return((l=(s=this._objectSpringBonesMap.get(o))==null?void 0:s.size)!=null?l:0)>0?!0:(this._ancestors.push(o),!1)})),this._isSortedJointsDirty=!1}_insertJointSort(e,t,n,i,r){if(n.has(e))return;if(t.has(e)){this._hasWarnedCircularDependency||(console.warn("VRMSpringBoneManager: Circular dependency detected"),this._hasWarnedCircularDependency=!0);return}t.add(e);const o=e.dependencies;for(const s of o){let l=!1,a=null;go(s,u=>{const h=this._objectSpringBonesMap.get(u);if(h)for(const d of h)l=!0,this._insertJointSort(d,t,n,i,r);else l||(a=u)}),a&&r.add(a)}i.push(e),n.add(e)}_relevantChildrenUpdated(e){var t,n;return((n=(t=this._objectSpringBonesMap.get(e))==null?void 0:t.size)!=null?n:0)>0?!0:(e.updateWorldMatrix(!1,!1),!1)}},yn="VRMC_springBone_extended_collider",Mo=new Set(["1.0","1.0-beta"]),xo=new Set(["1.0"]),Jn=class ie{get name(){return ie.EXTENSION_NAME}constructor(t,n){var i;this.parser=t,this.jointHelperRoot=n?.jointHelperRoot,this.colliderHelperRoot=n?.colliderHelperRoot,this.useExtendedColliders=(i=n?.useExtendedColliders)!=null?i:!0}afterRoot(t){return we(this,null,function*(){t.userData.vrmSpringBoneManager=yield this._import(t)})}_import(t){return we(this,null,function*(){const n=yield this._v1Import(t);if(n!=null)return n;const i=yield this._v0Import(t);return i??null})}_v1Import(t){return we(this,null,function*(){var n,i,r,o,s;const l=t.parser.json;if(!(((n=l.extensionsUsed)==null?void 0:n.indexOf(ie.EXTENSION_NAME))!==-1))return null;const u=new xn,h=yield t.parser.getDependencies("node"),d=(i=l.extensions)==null?void 0:i[ie.EXTENSION_NAME];if(!d)return null;const c=d.specVersion;if(!Mo.has(c))return console.warn(`VRMSpringBoneLoaderPlugin: Unknown ${ie.EXTENSION_NAME} specVersion "${c}"`),null;const p=(r=d.colliders)==null?void 0:r.map((f,_)=>{var v,R,w,y,M,x,T,A,b,P,L,O,X,se,ae;const W=h[f.node];if(W==null)return console.warn(`VRMSpringBoneLoaderPlugin: The collider #${_} attempted to reference a node #${f.node} but not found. Skipping the collider`),null;const D=f.shape,J=(v=f.extensions)==null?void 0:v[yn];if(this.useExtendedColliders&&J!=null){const le=J.specVersion;if(!xo.has(le))console.warn(`VRMSpringBoneLoaderPlugin: Unknown ${yn} specVersion "${le}". Fallbacking to the ${ie.EXTENSION_NAME} definition`);else{const U=J.shape;if(U.sphere)return this._importSphereCollider(W,{offset:new g().fromArray((R=U.sphere.offset)!=null?R:[0,0,0]),radius:(w=U.sphere.radius)!=null?w:0,inside:(y=U.sphere.inside)!=null?y:!1});if(U.capsule)return this._importCapsuleCollider(W,{offset:new g().fromArray((M=U.capsule.offset)!=null?M:[0,0,0]),radius:(x=U.capsule.radius)!=null?x:0,tail:new g().fromArray((T=U.capsule.tail)!=null?T:[0,0,0]),inside:(A=U.capsule.inside)!=null?A:!1});if(U.plane)return this._importPlaneCollider(W,{offset:new g().fromArray((b=U.plane.offset)!=null?b:[0,0,0]),normal:new g().fromArray((P=U.plane.normal)!=null?P:[0,0,1])})}}if(D.sphere)return this._importSphereCollider(W,{offset:new g().fromArray((L=D.sphere.offset)!=null?L:[0,0,0]),radius:(O=D.sphere.radius)!=null?O:0,inside:!1});if(D.capsule)return this._importCapsuleCollider(W,{offset:new g().fromArray((X=D.capsule.offset)!=null?X:[0,0,0]),radius:(se=D.capsule.radius)!=null?se:0,tail:new g().fromArray((ae=D.capsule.tail)!=null?ae:[0,0,0]),inside:!1});console.warn(`VRMSpringBoneLoaderPlugin: The collider #${_} has no valid shape. Skipping the collider`)}),m=(o=d.colliderGroups)==null?void 0:o.map((f,_)=>{var v;return{colliders:((v=f.colliders)!=null?v:[]).map(w=>{const y=p?.[w];return y??(console.warn(`VRMSpringBoneLoaderPlugin: The collider group #${_} attempted to reference a collider #${w} but not found. Skipping the collider`),null)}).filter(w=>w!=null),name:f.name}});return(s=d.springs)==null||s.forEach((f,_)=>{var v;const R=f.joints,w=(v=f.colliderGroups)==null?void 0:v.map(x=>{const T=m?.[x];return T??(console.warn(`VRMSpringBoneLoaderPlugin: The spring #${_} attempted to reference a collider group #${x} but not found. Skipping the collider group`),null)}).filter(x=>x!=null),y=f.center!=null?h[f.center]:void 0;let M;R.forEach(x=>{if(M){const T=M.node,A=h[T],b=x.node,P=h[b],L={hitRadius:M.hitRadius,dragForce:M.dragForce,gravityPower:M.gravityPower,stiffness:M.stiffness,gravityDir:M.gravityDir!=null?new g().fromArray(M.gravityDir):void 0},O=this._importJoint(A,P,L,w);y&&(O.center=y),u.addJoint(O)}M=x})}),u.setInitState(),u})}_v0Import(t){return we(this,null,function*(){var n,i,r;const o=t.parser.json;if(!(((n=o.extensionsUsed)==null?void 0:n.indexOf("VRM"))!==-1))return null;const l=(i=o.extensions)==null?void 0:i.VRM,a=l?.secondaryAnimation;if(!a)return null;const u=a?.boneGroups;if(!u)return null;const h=new xn,d=yield t.parser.getDependencies("node"),c=(r=a.colliderGroups)==null?void 0:r.map((p,m)=>{var f;const _=d[p.node];return _==null?(console.warn(`VRMSpringBoneLoaderPlugin: The collider group #${m} attempted to reference a node #${p.node} but not found. Skipping the collider group`),null):{colliders:((f=p.colliders)!=null?f:[]).map((R,w)=>{var y,M,x;const T=new g(0,0,0);return R.offset&&T.set((y=R.offset.x)!=null?y:0,(M=R.offset.y)!=null?M:0,R.offset.z?-R.offset.z:0),this._importSphereCollider(_,{offset:T,radius:(x=R.radius)!=null?x:0,inside:!1})})}});return u?.forEach((p,m)=>{const f=p.bones;f&&f.forEach(_=>{var v,R,w,y;const M=d[_];if(M==null){console.warn(`VRMSpringBoneLoaderPlugin: The spring bone group #${m} attempted to reference a node #${_} but not found. Skipping the node`);return}const x=new g;p.gravityDir?x.set((v=p.gravityDir.x)!=null?v:0,(R=p.gravityDir.y)!=null?R:0,(w=p.gravityDir.z)!=null?w:0):x.set(0,-1,0);const T=p.center!=null?d[p.center]:void 0,A={hitRadius:p.hitRadius,dragForce:p.dragForce,gravityPower:p.gravityPower,stiffness:p.stiffiness,gravityDir:x},b=(y=p.colliderGroups)==null?void 0:y.map(P=>{const L=c?.[P];return L??(console.warn(`VRMSpringBoneLoaderPlugin: The spring #${m} attempted to reference a collider group #${P} but not found. Skipping the collider group`),null)}).filter(P=>P!=null);M.traverse(P=>{var L;const O=(L=P.children[0])!=null?L:null,X=this._importJoint(P,O,A,b);T&&(X.center=T),h.addJoint(X)})})}),t.scene.updateMatrixWorld(),h.setInitState(),h})}_importJoint(t,n,i,r){const o=new _o(t,n,i,r);if(this.jointHelperRoot){const s=new uo(o);this.jointHelperRoot.add(s),s.renderOrder=this.jointHelperRoot.renderOrder}return o}_importSphereCollider(t,n){const i=new Zn(n),r=new Xe(i);if(t.add(r),this.colliderHelperRoot){const o=new je(r);this.colliderHelperRoot.add(o),o.renderOrder=this.colliderHelperRoot.renderOrder}return r}_importCapsuleCollider(t,n){const i=new Qn(n),r=new Xe(i);if(t.add(r),this.colliderHelperRoot){const o=new je(r);this.colliderHelperRoot.add(o),o.renderOrder=this.colliderHelperRoot.renderOrder}return r}_importPlaneCollider(t,n){const i=new $n(n),r=new Xe(i);if(t.add(r),this.colliderHelperRoot){const o=new je(r);this.colliderHelperRoot.add(o),o.renderOrder=this.colliderHelperRoot.renderOrder}return r}};Jn.EXTENSION_NAME="VRMC_springBone";var yo=Jn,es=class{get name(){return"VRMLoaderPlugin"}constructor(e,t){var n,i,r,o,s,l,a,u,h,d;this.parser=e;const c=t?.helperRoot,p=t?.autoUpdateHumanBones;this.expressionPlugin=(n=t?.expressionPlugin)!=null?n:new Nn(e),this.firstPersonPlugin=(i=t?.firstPersonPlugin)!=null?i:new Vn(e),this.humanoidPlugin=(r=t?.humanoidPlugin)!=null?r:new Hn(e,{helperRoot:c,autoUpdateHumanBones:p}),this.lookAtPlugin=(o=t?.lookAtPlugin)!=null?o:new zn(e,{helperRoot:c}),this.metaPlugin=(s=t?.metaPlugin)!=null?s:new jn(e),this.mtoonMaterialPlugin=(l=t?.mtoonMaterialPlugin)!=null?l:new Sr(e),this.materialsHDREmissiveMultiplierPlugin=(a=t?.materialsHDREmissiveMultiplierPlugin)!=null?a:new Ar(e),this.materialsV0CompatPlugin=(u=t?.materialsV0CompatPlugin)!=null?u:new Ur(e),this.springBonePlugin=(h=t?.springBonePlugin)!=null?h:new yo(e,{colliderHelperRoot:c,jointHelperRoot:c}),this.nodeConstraintPlugin=(d=t?.nodeConstraintPlugin)!=null?d:new to(e,{helperRoot:c})}beforeRoot(){return xe(this,null,function*(){yield this.materialsV0CompatPlugin.beforeRoot(),yield this.mtoonMaterialPlugin.beforeRoot()})}loadMesh(e){return xe(this,null,function*(){return yield this.mtoonMaterialPlugin.loadMesh(e)})}getMaterialType(e){const t=this.mtoonMaterialPlugin.getMaterialType(e);return t??null}extendMaterialParams(e,t){return xe(this,null,function*(){yield this.materialsHDREmissiveMultiplierPlugin.extendMaterialParams(e,t),yield this.mtoonMaterialPlugin.extendMaterialParams(e,t)})}afterRoot(e){return xe(this,null,function*(){yield this.metaPlugin.afterRoot(e),yield this.humanoidPlugin.afterRoot(e),yield this.expressionPlugin.afterRoot(e),yield this.lookAtPlugin.afterRoot(e),yield this.firstPersonPlugin.afterRoot(e),yield this.springBonePlugin.afterRoot(e),yield this.nodeConstraintPlugin.afterRoot(e),yield this.mtoonMaterialPlugin.afterRoot(e);const t=e.userData.vrmMeta,n=e.userData.vrmHumanoid;if(t&&n){const i=new cr({scene:e.scene,expressionManager:e.userData.vrmExpressionManager,firstPerson:e.userData.vrmFirstPerson,humanoid:n,lookAt:e.userData.vrmLookAt,meta:t,materials:e.userData.vrmMToonMaterials,springBoneManager:e.userData.vrmSpringBoneManager,nodeConstraintManager:e.userData.vrmNodeConstraintManager});e.userData.vrm=i}})}};function Ro(e){const t=new Set;return e.traverse(n=>{if(!n.isMesh)return;const i=n;t.add(i)}),t}function Rn(e,t,n){if(t.size===1){const s=t.values().next().value;if(s.weight===1)return e[s.index]}const i=new Float32Array(e[0].count*3);let r=0;if(n)r=1;else for(const s of t)r+=s.weight;for(const s of t){const l=e[s.index],a=s.weight/r;for(let u=0;u<l.count;u++)i[u*3+0]+=l.getX(u)*a,i[u*3+1]+=l.getY(u)*a,i[u*3+2]+=l.getZ(u)*a}return new C(i,3)}function wo(e){var t;const n=Ro(e.scene),i=new Map,r=(t=e.expressionManager)==null?void 0:t.expressionMap;if(r!=null)for(const[o,s]of Object.entries(r)){const l=new Set;for(const a of s.binds)if(a instanceof Le){if(a.weight!==0)for(const u of a.primitives){let h=i.get(u);h==null&&(h=new Map,i.set(u,h));let d=h.get(o);d==null&&(d=new Set,h.set(o,d)),d.add(a)}l.add(a)}for(const a of l)s.deleteBind(a)}for(const o of n){const s=i.get(o);if(s==null)continue;const l=o.geometry.morphAttributes;o.geometry.morphAttributes={};const a=o.geometry.clone();o.geometry=a;const u=a.morphTargetsRelative,h=l.position!=null,d=l.normal!=null,c={},p={},m=[];if(h||d){h&&(c.position=[]),d&&(c.normal=[]);let f=0;for(const[_,v]of s)h&&(c.position[f]=Rn(l.position,v,u)),d&&(c.normal[f]=Rn(l.normal,v,u)),r?.[_].addBind(new Le({index:f,weight:1,primitives:[o]})),p[_]=f,m.push(0),f++}a.morphAttributes=c,o.morphTargetDictionary=p,o.morphTargetInfluences=m}}function Ie(e,t,n){if(e.getComponent)return e.getComponent(t,n);{let i=e.array[t*e.itemSize+n];return e.normalized&&(i=I.denormalize(i,e.array)),i}}function Kn(e,t,n,i){e.setComponent?e.setComponent(t,n,i):(e.normalized&&(i=I.normalize(i,e.array)),e.array[t*e.itemSize+n]=i)}function To(e){var t;const n=So(e),i=new Set;for(const d of n)i.has(d.geometry)&&(d.geometry=Io(d.geometry)),i.add(d.geometry);const r=new Map;for(const d of i){const c=d.getAttribute("skinIndex"),p=(t=r.get(c))!=null?t:new Map;r.set(c,p);const m=d.getAttribute("skinWeight"),f=Eo(c,m);p.set(m,f)}const o=new Map;for(const d of n){const c=Ao(d,r);o.set(d,c)}const s=[];for(const[d,c]of o){let p=!1;for(const m of s)if(Po(c,m.boneInverseMap)){p=!0,m.meshes.add(d);for(const[_,v]of c)m.boneInverseMap.set(_,v);break}p||s.push({boneInverseMap:c,meshes:new Set([d])})}const l=new Map,a=new Ye,u=new Ye,h=new Ye;for(const d of s){const{boneInverseMap:c,meshes:p}=d,m=Array.from(c.keys()),f=Array.from(c.values()),_=new et(m,f),v=u.getOrCreate(_);for(const R of p){const w=R.geometry.getAttribute("skinIndex"),y=a.getOrCreate(w),M=R.skeleton.bones,x=M.map(b=>h.getOrCreate(b)).join(","),T=`${y};${v};${x}`;let A=l.get(T);A==null&&(A=w.clone(),Lo(A,M,m),l.set(T,A)),R.geometry.setAttribute("skinIndex",A)}for(const R of p)R.bind(_,new z)}}function So(e){const t=new Set;return e.traverse(n=>{if(!n.isSkinnedMesh)return;const i=n;t.add(i)}),t}function Eo(e,t){const n=new Set;for(let i=0;i<e.count;i++)for(let r=0;r<e.itemSize;r++){const o=Ie(e,i,r);Ie(t,i,r)!==0&&n.add(o)}return n}function Ao(e,t){const n=new Map,i=e.skeleton,r=e.geometry,o=r.getAttribute("skinIndex"),s=r.getAttribute("skinWeight"),l=t.get(o),a=l?.get(s);if(!a)throw new Error("Unreachable. attributeUsedIndexSetMap does not know the skin index attribute or the skin weight attribute.");for(const u of a)n.set(i.bones[u],i.boneInverses[u]);return n}function Po(e,t){for(const[n,i]of e.entries()){const r=t.get(n);if(r!=null&&!bo(i,r))return!1}return!0}function Lo(e,t,n){const i=new Map;for(const o of t)i.set(o,i.size);const r=new Map;for(const[o,s]of n.entries()){const l=i.get(s);r.set(l,o)}for(let o=0;o<e.count;o++)for(let s=0;s<e.itemSize;s++){const l=Ie(e,o,s),a=r.get(l);Kn(e,o,s,a)}e.needsUpdate=!0}function bo(e,t,n){if(n=n||1e-4,e.elements.length!=t.elements.length)return!1;for(let i=0,r=e.elements.length;i<r;i++)if(Math.abs(e.elements[i]-t.elements[i])>n)return!1;return!0}var Ye=class{constructor(){this._objectIndexMap=new Map,this._index=0}get(e){return this._objectIndexMap.get(e)}getOrCreate(e){let t=this._objectIndexMap.get(e);return t==null&&(t=this._index,this._objectIndexMap.set(e,t),this._index++),t}};function Io(e){var t,n,i,r;const o=new j;o.name=e.name,o.setIndex(e.index);for(const[s,l]of Object.entries(e.attributes))o.setAttribute(s,l);for(const[s,l]of Object.entries(e.morphAttributes)){const a=s;o.morphAttributes[a]=l.concat()}o.morphTargetsRelative=e.morphTargetsRelative,o.groups=[];for(const s of e.groups)o.addGroup(s.start,s.count,s.materialIndex);return o.boundingSphere=(n=(t=e.boundingSphere)==null?void 0:t.clone())!=null?n:null,o.boundingBox=(r=(i=e.boundingBox)==null?void 0:i.clone())!=null?r:null,o.drawRange.start=e.drawRange.start,o.drawRange.count=e.drawRange.count,o.userData=e.userData,o}function wn(e){if(Object.values(e).forEach(t=>{t?.isTexture&&t.dispose()}),e.isShaderMaterial){const t=e.uniforms;t&&Object.values(t).forEach(n=>{const i=n.value;i?.isTexture&&i.dispose()})}e.dispose()}function Oo(e){const t=e.geometry;t&&t.dispose();const n=e.skeleton;n&&n.dispose();const i=e.material;i&&(Array.isArray(i)?i.forEach(r=>wn(r)):i&&wn(i))}function Co(e){e.traverse(Oo)}function Uo(e,t){var n,i;console.warn("VRMUtils.removeUnnecessaryJoints: removeUnnecessaryJoints is deprecated. Use combineSkeletons instead. combineSkeletons contributes more to the performance improvement. This function will be removed in the next major version.");const r=(n=t?.experimentalSameBoneCounts)!=null?n:!1,o=[];e.traverse(a=>{a.type==="SkinnedMesh"&&o.push(a)});const s=new Map;let l=0;for(const a of o){const h=a.geometry.getAttribute("skinIndex");if(s.has(h))continue;const d=new Map,c=new Map;for(let p=0;p<h.count;p++)for(let m=0;m<h.itemSize;m++){const f=Ie(h,p,m);let _=d.get(f);_==null&&(_=d.size,d.set(f,_),c.set(_,f)),Kn(h,p,m,_)}h.needsUpdate=!0,s.set(h,c),l=Math.max(l,d.size)}for(const a of o){const h=a.geometry.getAttribute("skinIndex"),d=s.get(h),c=[],p=[],m=r?l:d.size;for(let _=0;_<m;_++){const v=(i=d.get(_))!=null?i:0;c.push(a.skeleton.bones[v]),p.push(a.skeleton.boneInverses[v])}const f=new et(c,p);a.bind(f,new z)}}function No(e,t){const n=e.position.count,i=new Array(n);let r=0;const o=t.array;for(let s=0;s<o.length;s++){const l=o[s];i[l]||(i[l]=!0,r++)}return{isVertexUsed:i,vertexCount:n,verticesUsed:r}}function Vo(e){const t=[],n=[];let i=0;for(let r=0;r<e.length;r++)if(e[r]){const o=i++;t[r]=o,n[o]=r}return{originalIndexNewIndexMap:t,newIndexOriginalIndexMap:n}}function Do(e,t){var n,i,r,o;t.name=e.name,t.morphTargetsRelative=e.morphTargetsRelative,e.groups.forEach(s=>{t.addGroup(s.start,s.count,s.materialIndex)}),t.boundingBox=(i=(n=e.boundingBox)==null?void 0:n.clone())!=null?i:null,t.boundingSphere=(o=(r=e.boundingSphere)==null?void 0:r.clone())!=null?o:null,t.setDrawRange(e.drawRange.start,e.drawRange.count),t.userData=e.userData}function Bo(e,t,n){const i=t.array,r=new i.constructor(i.length);for(let o=0;o<i.length;o++){const s=i[o];r[o]=n[s]}e.setIndex(new C(r,t.itemSize,t.normalized))}function Oe(e,t,n){const i=e.constructor,r=new i(t.length*n);let o=!0;for(let s=0;s<t.length;s++){const a=t[s]*n,u=s*n;for(let h=0;h<n;h++){const d=e[a+h];r[u+h]=d,o=o&&d===0}}return[r,o]}function Fo(e){var t;const n=new Map,i=[];for(const[r,o]of Object.entries(e))if(o.isInterleavedBufferAttribute){const s=o,l=s.data,a=(t=n.get(l))!=null?t:[];n.set(l,a),a.push([r,s])}else{const s=o;i.push([r,s])}return[n,i]}function Ho(e,t,n){const[i,r]=Fo(t);for(const[o,s]of i){const l=o.array,{stride:a}=o,[u]=Oe(l,n,a),h=new Tn(u,a);h.setUsage(o.usage);for(const[d,c]of s){const{itemSize:p,offset:m,normalized:f}=c,_=new Sn(h,p,m,f);e.setAttribute(d,_)}}for(const[o,s]of r){const l=s.array,{itemSize:a,normalized:u}=s,[h]=Oe(l,n,a);e.setAttribute(o,new C(h,a,u))}}function ko(e){var t;const n=new Map,i=[];for(const[r,o]of Object.entries(e)){const s=r;for(let l=0;l<o.length;l++){const a=o[l];if(a.isInterleavedBufferAttribute){const u=a,h=u.data,d=(t=n.get(h))!=null?t:[];n.set(h,d),d.push([s,l,u])}else{const u=a;i.push([s,l,u])}}}return[n,i]}function Wo(e,t,n){var i,r;let o=!0;const[s,l]=ko(t),a={};for(const[u,h]of s){const d=u.array,{stride:c}=u,[p,m]=Oe(d,n,c);o=o&&m;const f=new Tn(p,c);f.setUsage(u.usage);for(const[_,v,R]of h){const{itemSize:w,offset:y,normalized:M}=R,x=new Sn(f,w,y,M);(i=a[_])!=null||(a[_]=[]),a[_][v]=x}}for(const[u,h,d]of l){const c=d,p=c.array,{itemSize:m,normalized:f}=c,[_,v]=Oe(p,n,m);o=o&&v,(r=a[u])!=null||(a[u]=[]),a[u][h]=new C(_,m,f)}e.morphAttributes=o?{}:a}function zo(e){const t=new Map;e.traverse(n=>{if(!n.isMesh)return;const i=n,r=i.geometry,o=r.index;if(o==null)return;const s=t.get(r);if(s!=null){i.geometry=s;return}const{isVertexUsed:l,vertexCount:a,verticesUsed:u}=No(r.attributes,o);if(u===a)return;const{originalIndexNewIndexMap:h,newIndexOriginalIndexMap:d}=Vo(l),c=new j;Do(r,c),t.set(r,c),Bo(c,o,h),Ho(c,r.attributes,d),Wo(c,r.morphAttributes,d),i.geometry=c}),Array.from(t.keys()).forEach(n=>{n.dispose()})}function jo(e){var t;((t=e.meta)==null?void 0:t.metaVersion)==="0"&&(e.scene.rotation.y=Math.PI)}var oe=class{constructor(){}};oe.combineMorphs=wo;oe.combineSkeletons=To;oe.deepDispose=Co;oe.removeUnnecessaryJoints=Uo;oe.removeUnnecessaryVertices=zo;oe.rotateVRM0=jo;export{wr as MToonMaterial,yr as MToonMaterialDebugMode,Sr as MToonMaterialLoaderPlugin,pn as MToonMaterialOutlineWidthMode,cr as VRM,jr as VRMAimConstraint,Xn as VRMCore,Ko as VRMCoreLoaderPlugin,kt as VRMExpression,Nn as VRMExpressionLoaderPlugin,jt as VRMExpressionManager,Xt as VRMExpressionMaterialColorBind,de as VRMExpressionMaterialColorType,Le as VRMExpressionMorphTargetBind,Qo as VRMExpressionOverrideType,qe as VRMExpressionPresetName,Yt as VRMExpressionTextureTransformBind,qt as VRMFirstPerson,Vn as VRMFirstPersonLoaderPlugin,$o as VRMFirstPersonMeshAnnotationType,Ve as VRMHumanBoneList,Zo as VRMHumanBoneName,Xi as VRMHumanBoneParentMap,Kt as VRMHumanoid,Zt as VRMHumanoidHelper,Hn as VRMHumanoidLoaderPlugin,es as VRMLoaderPlugin,ar as VRMLookAt,Se as VRMLookAtBoneApplier,Ze as VRMLookAtExpressionApplier,Ki as VRMLookAtHelper,zn as VRMLookAtLoaderPlugin,un as VRMLookAtRangeMap,Jo as VRMLookAtTypeName,jn as VRMMetaLoaderPlugin,rt as VRMNodeConstraint,ke as VRMNodeConstraintHelper,to as VRMNodeConstraintLoaderPlugin,Gr as VRMNodeConstraintManager,qi as VRMRequiredHumanBoneName,Kr as VRMRollConstraint,Qr as VRMRotationConstraint,Xe as VRMSpringBoneCollider,je as VRMSpringBoneColliderHelper,ot as VRMSpringBoneColliderShape,Qn as VRMSpringBoneColliderShapeCapsule,$n as VRMSpringBoneColliderShapePlane,Zn as VRMSpringBoneColliderShapeSphere,_o as VRMSpringBoneJoint,uo as VRMSpringBoneJointHelper,yo as VRMSpringBoneLoaderPlugin,xn as VRMSpringBoneManager,oe as VRMUtils};
//# sourceMappingURL=three-vrm.module-ChZfjX_C.js.map
