import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";
import {expect,test} from "vitest";
const source=readFileSync(new URL("../cli-login-page.tsx",import.meta.url),"utf8");
const start=source.indexOf("export function cliLoginSignInHref("),end=source.indexOf("export default function",start);
const build=new Function(stripTypeScriptTypes(source.slice(start,end).replace("export ",""),{mode:"strip"})+";return cliLoginSignInHref;")();
test("only one exact Google hint starts Google and preserves the session return",()=>{
 const result=new URL(build(new URLSearchParams("session=owned&app=alpha&provider=google")),"https://eliza.app");
 expect(result.searchParams.get("nativeProvider")).toBe("google");expect(result.searchParams.get("returnTo")).toBe("/auth/cli-login?session=owned&app=alpha");
 for(const query of ["provider=github","provider=Google","provider=google&provider=google","provider=https://evil.invalid"]){expect(new URL(build(new URLSearchParams(query)),"https://eliza.app").searchParams.has("nativeProvider")).toBe(false);}
});
