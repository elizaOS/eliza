// Trusted host parser only. Candidate JavaScript is parsed as data, never imported or evaluated.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const base=path.dirname(new URL(import.meta.url).pathname);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const custody=JSON.parse(fs.readFileSync(base+'/HOST-PARSER-CUSTODY.json'));
if(sha(fs.readFileSync(custody.path))!==custody.SHA256)throw Error('Host parser changed');
const ts=createRequire(import.meta.url)(custody.path);
const groups={};
for(const filename of fs.readdirSync(base+'/source/test').sort()){
 const raw=fs.readFileSync(base+'/source/test/'+filename),sf=ts.createSourceFile(filename,raw.toString(),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 if(sf.parseDiagnostics.length)throw Error('Candidate parse diagnostic');
 const opaque=n=>({opaqueSourceStart:n.getStart(sf),opaqueSourceKind:ts.SyntaxKind[n.kind]});
 const isOpaque=x=>!!x&&typeof x==='object'&&Object.hasOwn(x,'opaqueSourceStart');
 const primitive=x=>{if(x!==null&&typeof x==='object')throw Error('Title depends on opaque/nonprimitive candidate value');return x;};
 const vars=new Map();
 for(const s of sf.statements)if(ts.isVariableStatement(s))for(const d of s.declarationList.declarations)if(ts.isIdentifier(d.name)&&d.initializer)vars.set(d.name.text,d.initializer);
 function value(n,env,seen=new Set()){
  if(!n)return undefined;
  if(ts.isParenthesizedExpression(n))return value(n.expression,env,seen);
  if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n))return n.text;
  if(ts.isNumericLiteral(n))return Number(n.text);
  if(n.kind===ts.SyntaxKind.NullKeyword)return null;
  if(n.kind===ts.SyntaxKind.TrueKeyword)return true;
  if(n.kind===ts.SyntaxKind.FalseKeyword)return false;
  if(ts.isIdentifier(n)){
   if(env.has(n.text))return env.get(n.text);
   if(n.text==='undefined')return undefined;
   if(vars.has(n.text)&&!seen.has(n.text))return value(vars.get(n.text),env,new Set([...seen,n.text]));
   return opaque(n);
  }
  if(ts.isArrayLiteralExpression(n))return n.elements.map(e=>{if(ts.isSpreadElement(e))throw Error('Unreviewed spread in registration data');return value(e,env,seen);});
  if(ts.isObjectLiteralExpression(n)){
   const out=Object.create(null);
   for(const p of n.properties){
    if(!ts.isPropertyAssignment(p)&&!ts.isMethodDeclaration(p)&&!ts.isShorthandPropertyAssignment(p))return opaque(n);
    const k=ts.isIdentifier(p.name)||ts.isStringLiteral(p.name)||ts.isNumericLiteral(p.name)?p.name.text:null;
    if(k===null||Object.hasOwn(out,k))throw Error('Unknown or duplicate registration object key');
    out[k]=ts.isPropertyAssignment(p)?value(p.initializer,env,seen):opaque(p);
   }return out;
  }
  if(ts.isTemplateExpression(n))return n.head.text+n.templateSpans.map(s=>String(primitive(value(s.expression,env,seen)))+s.literal.text).join('');
  if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.PlusToken){const a=primitive(value(n.left,env,seen)),b=primitive(value(n.right,env,seen));return a+b;}
  if(ts.isElementAccessExpression(n)){const obj=value(n.expression,env,seen),key=primitive(value(n.argumentExpression,env,seen));if(isOpaque(obj)||obj===null||!Object.hasOwn(obj,key))throw Error('Unknown registration key');return obj[key];}
  if(ts.isCallExpression(n)){
   const callee=n.expression.getText(sf);
   if(callee==='String'&&n.arguments.length===1)return String(primitive(value(n.arguments[0],env,seen)));
   if(['Object.keys','Object.entries'].includes(callee)&&n.arguments.length===1){const obj=value(n.arguments[0],env,seen);if(!obj||isOpaque(obj)||Array.isArray(obj))throw Error('Unknown registration object');return callee==='Object.keys'?Object.keys(obj):Object.entries(obj);}
  }
  // Function bodies, callbacks, reads, VM code and all other calls stay opaque data.
  return opaque(n);
 }
 function bind(n,v,env){
  if(ts.isIdentifier(n)){env.set(n.text,v);return;}
  if(ts.isArrayBindingPattern(n)&&Array.isArray(v)){for(let i=0;i<n.elements.length;i++){const e=n.elements[i];if(ts.isOmittedExpression(e))continue;if(e.dotDotDotToken||e.initializer)throw Error('Unreviewed binding');bind(e.name,v[i],env);}return;}
  throw Error('Unreviewed registration binding');
 }
 const imports=sf.statements.filter(ts.isImportDeclaration).filter(s=>s.moduleSpecifier.text==='node:test');
 if(imports.length!==1||imports[0].importClause?.name?.text!=='test'||imports[0].importClause?.namedBindings)throw Error('Unexpected Node registrar import');
 const cases=[],declarations=[],references=[];
 function walk(n){
  if(ts.isIdentifier(n)&&n.text==='test')references.push(n);
  if(ts.isCallExpression(n)&&n.expression.getText(sf)==='test'){
   const p=sf.getLineAndCharacterOfPosition(n.getStart(sf)),loops=[];
   let a=n.parent;
   while(a&&a!==sf){
    if(ts.isFunctionLike(a))throw Error('Unreviewed function-scoped registrar');
    if(ts.isForOfStatement(a))loops.unshift(a);
    else if(ts.isIfStatement(a)||ts.isForStatement(a)||ts.isWhileStatement(a)||ts.isSwitchStatement(a)||ts.isTryStatement(a))throw Error('Conditional/unreviewed registrar control flow');
    a=a.parent;
   }
   if(n.arguments.length<2||n.arguments.length>3||!ts.isArrowFunction(n.arguments.at(-1))&&!ts.isFunctionExpression(n.arguments.at(-1)))throw Error('Unreviewed registrar signature');
   if(n.arguments.length===3){const opts=value(n.arguments[1],new Map());if(isOpaque(opts)||Object.keys(opts).some(k=>['skip','todo','only'].includes(k)))throw Error('Selective registration option');}
   declarations.push({sourceLine:p.line+1,sourceColumn:p.character+1,loopCount:loops.length});
   function expand(i,env,rows){
    if(i<loops.length){const l=loops[i];if(!ts.isVariableDeclarationList(l.initializer)||l.initializer.declarations.length!==1)throw Error('Unknown for-of binding');const values=value(l.expression,env);if(!Array.isArray(values)||values.length>1000)throw Error('Unknown registration iterable');for(let j=0;j<values.length;j++){const next=new Map(env);bind(l.initializer.declarations[0].name,values[j],next);expand(i+1,next,[...rows,{loopLine:sf.getLineAndCharacterOfPosition(l.getStart(sf)).line+1,rowIndex:j}]);}return;}
    const title=primitive(value(n.arguments[0],env));if(typeof title!=='string'||!title)throw Error('Unknown test title');
    const identity={file:'test/'+filename,sourceLine:p.line+1,sourceColumn:p.character+1,leafTitle:title,nesting:0,loopRows:rows};
    cases.push({...identity,sourceCaseID:sha(JSON.stringify(identity))});
   }expand(0,new Map(),[]);
  }
  ts.forEachChild(n,walk);
 }walk(sf);
 // Every reference to the imported registrar is its direct call or import binding.
 for(const r of references)if(r!==imports[0].importClause.name&&!(ts.isCallExpression(r.parent)&&r.parent.expression===r))throw Error('Unreviewed Node registrar use at '+r.getStart(sf));
 if(new Set(cases.map(c=>c.sourceCaseID)).size!==cases.length)throw Error('Duplicate source identity');
 const id='google-offline-'+String(Object.keys(groups).length+1);
 groups[id]={repository:'Alpha',file:'test/'+filename,expectedModule:'/workspace/alpha/test/'+filename,SHA256:sha(raw),syntacticDeclarations:declarations.length,expectedSourceCaseCount:cases.length,expectedNestedCases:[],cases,declarations};
}
const result={schemaVersion:1,state:'SOURCE_DERIVED_NOT_EXECUTED',sources:{Alpha:'bcdefded4530202a283c77819b48d7ec40b05cbb',SDK:'ff04a558747ed426d9d871a319f7b3946f7660e6'},method:'Hash-pinned trusted host TypeScript AST; restricted data-only literal/title/loop expansion. No candidate evaluation/import. All registrar uses closed; callbacks opaque; no nested cases.',groups,totalExpectedSourceCases:Object.values(groups).reduce((n,g)=>n+g.expectedSourceCaseCount,0)};
fs.writeFileSync(base+'/SOURCE-CASE-CENSUS.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({state:result.state,total:result.totalExpectedSourceCases,files:Object.values(groups).map(g=>({file:g.file,declarations:g.syntacticDeclarations,cases:g.expectedSourceCaseCount}))},null,2));
