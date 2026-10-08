import { serve } from "bun";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { createTeiEmbeddingModel } from "./tei-embeddings";
import { createBgeEmbeddingModel } from "./bge-embeddings";
import { prepareBgeEmbeddingInput } from "@elizaos/plugin-native-inference/model-catalog/bge-input";
const originalFetch = globalThis.fetch;
const revision = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a";
const identity = {model_id:"BAAI/bge-small-en-v1.5",model_sha:revision,model_type:{embedding:{pooling:"cls"}},max_input_length:512};
afterEach(() => { globalThis.fetch=originalFetch; });
function fixture(responses: unknown[]) {
  const calls: {url:string;init?:RequestInit}[]=[];
  globalThis.fetch=(async (url: string|URL|Request,init?:RequestInit) => {calls.push({url:String(url),init}); const response=responses.shift(); return response instanceof Response ? response : Response.json(response);}) as typeof fetch;
  return calls;
}
describe("canonical BGE TEI identity and transport boundary", () => {
  for (const changed of [{model_sha:null},{model_sha:"different-revision"},{model_type:{embedding:{pooling:"mean"}}},{max_input_length:256},{model_id:"thenlper/gte-small"}]) {
    test(`blocks incompatible identity ${JSON.stringify(changed)} before embedding`, async () => {
      const calls=fixture([{...identity,...changed}]);await expect(createTeiEmbeddingModel("https://fixture.invalid","fixture-key").doEmbed({values:["fixture"]})).rejects.toThrow();expect(calls).toHaveLength(1);expect(calls[0].url.endsWith("/info")).toBe(true);
    });
  }
  test("uses real local HTTP, canonical source tail and header-only credential", async () => {
    const captured:{path:string;authorization:string|null;body:string}[]=[];
    const server=serve({hostname:"127.0.0.1",port:0,async fetch(req){const path=new URL(req.url).pathname;captured.push({path,authorization:req.headers.get("authorization"),body:await req.text()});return path==="/info" ? Response.json(identity) : Response.json([Array(384).fill(2)]);}});
    try {
      const model=createTeiEmbeddingModel(`http://127.0.0.1:${server.port}/v1`,"fixture-owned-key");
      const input="old context ".repeat(600)+"the retained final query";const prepared=prepareBgeEmbeddingInput(input);const result=await model.doEmbed({values:[input]});
      expect(result.embeddings[0]).toHaveLength(384);expect(Math.hypot(...result.embeddings[0])).toBeCloseTo(1,12);expect(model.embeddingSpace).toBe("BAAI/bge-small-en-v1.5:cls:l2:384:hf-bert-v1:tail-v1");expect(result.usage?.tokens).toBe(prepared.tokenIds.length);
      expect(captured.map(x=>x.path)).toEqual(["/info","/embed"]);expect(captured.every(x=>x.authorization==="Bearer fixture-owned-key")).toBe(true);expect(captured.every(x=>!x.body.includes("fixture-owned-key"))).toBe(true);expect(JSON.parse(captured[1].body)).toEqual({inputs:[prepared.text],normalize:true,truncate:false});expect(prepared.tokenIds.length).toBeLessThanOrEqual(512);expect(input.endsWith(prepared.text)).toBe(true);
    } finally { server.stop(true); }
  });
  for (const vectors of [[Array(383).fill(1)],[Array(384).fill(0)],[],[Array(384).fill("invalid")]]) {
    test(`rejects invalid output shape ${vectors[0]?.length ?? 0}`,async()=>{fixture([identity,vectors]);await expect(createTeiEmbeddingModel("https://fixture.invalid","fixture-key").doEmbed({values:["fixture"]})).rejects.toThrow();});
  }
  test("preflight HTTP rejection dispatches no embedding",async()=>{const calls=fixture([new Response("fixture",{status:401})]);await expect(createTeiEmbeddingModel("https://fixture.invalid","fixture-key").doEmbed({values:["fixture"]})).rejects.toThrow();expect(calls).toHaveLength(1);});
  test("inference HTTP failure remains a single failed request",async()=>{const calls=fixture([identity,new Response("fixture",{status:503})]);await expect(createTeiEmbeddingModel("https://fixture.invalid","fixture-key").doEmbed({values:["fixture"]})).rejects.toThrow();expect(calls).toHaveLength(2);});
  test("invalid source rejects entire batch before transport",async()=>{const transport=mock(async()=>({data:[]}));await expect(createBgeEmbeddingModel(transport,{provider:"selfhosted",modelId:"bge-small-en-v1.5"}).doEmbed({values:["valid","\ud800"]})).rejects.toThrow();expect(transport).not.toHaveBeenCalled();});
  test("accepted prefix is not silently replayed after batch failure",async()=>{let count=0;const transport=mock(async(values:string[])=>{if(++count===2)throw Error("fixture-failure");return{data:values.map(()=>Array(384).fill(1))};});await expect(createBgeEmbeddingModel(transport,{provider:"selfhosted",modelId:"bge-small-en-v1.5"}).doEmbed({values:Array(101).fill("fixture")})).rejects.toMatchObject({code:"EMBEDDING_BATCH_PARTIALLY_ACCEPTED"});expect(transport).toHaveBeenCalledTimes(2);});
  test("normalizer keeps scalar Greek case and supplementary CJK token boundaries",()=>{expect(prepareBgeEmbeddingInput("ΟΣ").tokenIds).toEqual(prepareBgeEmbeddingInput("οσ").tokenIds);expect(prepareBgeEmbeddingInput("a𠀀b").tokenIds).toEqual(prepareBgeEmbeddingInput("a 𠀀 b").tokenIds);});
  test("long input retains an exact content-token suffix",()=>{const text="repeat ".repeat(700)+"final words";const content=[...Array(700).fill(prepareBgeEmbeddingInput("repeat").tokenIds[1]),...prepareBgeEmbeddingInput("final words").tokenIds.slice(1,-1)],tail=prepareBgeEmbeddingInput(text);expect(tail.tokenIds[0]).toBe(101);expect(tail.tokenIds.at(-1)).toBe(102);expect(tail.tokenIds.slice(1,-1)).toEqual(content.slice(-(tail.tokenIds.length-2)));expect(text.endsWith(tail.text)).toBe(true);});
});
