const fs=require('fs'),path=require('path'),util=require('util');
const ts=require('/Users/nubs/Git/alpha-direct-current-35-20261102/artifacts/local-agent-resident-35e0a605b3d560eedec664e79693d5ecc0b5ece3-r2/node_modules/typescript/lib/typescript.js');
function titleFormat(title,args,index){let i=0;return title.replace(/%[%#sdijfp]/g,t=>{if(t==='%%')return '%';if(t==='%#')return String(index);const v=args[i++];if(t==='%j')return JSON.stringify(v);if(t==='%i'||t==='%d')return String(parseInt(v));if(t==='%f')return String(Number(v));if(t==='%p')return util.inspect(v);return String(v)});}
const root=__dirname, manifest=JSON.parse(fs.readFileSync(path.join(root,'TEST-SOURCES.json')));
function bind(name,value,env){if(ts.isIdentifier(name))env[name.text]=value;else if(ts.isObjectBindingPattern(name)){for(const x of name.elements){if(!ts.isBindingElement(x)||x.dotDotDotToken)throw Error('Unsupported object binding');bind(x.name,value?.[x.propertyName?.text??x.name.text],env)}}else if(ts.isArrayBindingPattern(name))name.elements.forEach((x,i)=>{if(ts.isBindingElement(x))bind(x.name,value?.[i],env)});}
function evaluate(n,env){
 if(!n)return undefined;
 if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n))return n.text;
 if(ts.isNumericLiteral(n))return Number(n.text);
 if(n.kind===ts.SyntaxKind.NullKeyword)return null;
 if(n.kind===ts.SyntaxKind.TrueKeyword)return true;
 if(n.kind===ts.SyntaxKind.FalseKeyword)return false;
 if(ts.isIdentifier(n))return env[n.text];
 if(ts.isAsExpression(n)||ts.isParenthesizedExpression(n))return evaluate(n.expression,env);
 if(ts.isArrayLiteralExpression(n))return n.elements.map(x=>evaluate(x,env));
 if(ts.isObjectLiteralExpression(n)){const out={};for(const x of n.properties){if(!ts.isPropertyAssignment(x))return undefined;out[x.name.text]=evaluate(x.initializer,env)}return out}
 if(ts.isConditionalExpression(n)){const c=evaluate(n.condition,env);return c===undefined?undefined:evaluate(c?n.whenTrue:n.whenFalse,env)}
 if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)){
  const receiver=n.expression.expression.getText(),method=n.expression.name.text,values=n.arguments.map(x=>evaluate(x,env));
  if(receiver==='JSON'&&method==='stringify')return JSON.stringify(values[0]);
  if(receiver==='Object'&&method==='keys'&&values[0]&&typeof values[0]==='object')return Object.keys(values[0]);
  const a=evaluate(n.expression.expression,env),fn=n.arguments[0];
  if(Array.isArray(a)&&['map','flatMap'].includes(method)&&fn&&ts.isArrowFunction(fn)){
   const result=a.map((item,i)=>{const next={...env};bind(fn.parameters[0].name,item,next);if(fn.parameters[1])bind(fn.parameters[1].name,i,next);return evaluate(fn.body,next)});
   return method==='flatMap'?result.flat():result;
  }
 }
 if(ts.isPropertyAccessExpression(n))return evaluate(n.expression,env)?.[n.name.text];
 if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.PlusToken){const a=evaluate(n.left,env),b=evaluate(n.right,env);return a===undefined||b===undefined?undefined:a+b}
 if(ts.isTemplateExpression(n)){let out=n.head.text;for(const s of n.templateSpans){const v=evaluate(s.expression,env);if(v===undefined)return undefined;out+=v+s.literal.text}return out}
 return undefined;
}
for(const [lane,part] of Object.entries(manifest))for(const file of part.files){
 const src=ts.createSourceFile(file.path,fs.readFileSync(path.join(root,'source-tests',lane,file.path),'utf8'),ts.ScriptTarget.Latest,true),rows=[];
 const helpers=new Map();
 function visit(n,env={}){
  if(ts.isFunctionDeclaration(n)&&n.name){helpers.set(n.name.text,n);return}
  if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)){env[n.name.text]=evaluate(n.initializer,env);return}
  if(ts.isForOfStatement(n)){const values=evaluate(n.expression,env);const name=n.initializer.declarations?.[0]?.name;if(Array.isArray(values)&&name){for(const v of values){const next={...env};bind(name,v,next);visit(n.statement,next)}return}}
  if(ts.isCallExpression(n)){
   if(ts.isIdentifier(n.expression)&&helpers.has(n.expression.text)){
    const fn=helpers.get(n.expression.text),next={...env};fn.parameters.forEach((p,i)=>bind(p.name,evaluate(n.arguments[i],env),next));visit(fn.body,next);return;
   }
   let e=n.expression,table=null;
   if(ts.isCallExpression(e)&&ts.isPropertyAccessExpression(e.expression)&&e.expression.name.text==='each'){table=evaluate(e.arguments[0],env);e=e.expression.expression}
   const name=e.getText(src);
   if(/^(test|it)(\.(skip|todo|only))?$/.test(name)){
    const title=evaluate(n.arguments[0],env),line=src.getLineAndCharacterOfPosition(n.getStart(src)).line+1;
    if(table!==null){if(!Array.isArray(table))rows.push({line,unresolved:n.getText(src).slice(0,160)});else table.forEach((item,index)=>rows.push({line,name:typeof title==='string'?titleFormat(title,Array.isArray(item)?item:[item],index):null,mode:name,sourceTitlePattern:title,parameterRowIndex:index,parameterRow:item}));}
    else rows.push({line,name:typeof title==='string'?title:null,mode:name,unresolved:typeof title==='string'?undefined:n.arguments[0]?.getText(src)});
    return;
   }
  }
  ts.forEachChild(n,child=>visit(child,env));
 }
 visit(src);file.tests=rows;file.staticCount=rows.length;file.unresolved=rows.filter(x=>!x.name).length;
}
fs.writeFileSync(path.join(root,'STATIC-TEST-INVENTORY.json'),JSON.stringify(manifest,null,2)+'\n');
for(const [lane,p] of Object.entries(manifest))for(const f of p.files)console.log(lane,f.path,f.staticCount,'unresolved='+f.unresolved);
