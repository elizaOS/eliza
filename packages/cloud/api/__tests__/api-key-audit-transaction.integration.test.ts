import {beforeAll,afterAll,test,expect,mock} from "bun:test";
import {sql} from "drizzle-orm";
import {createHash} from "node:crypto";
process.env.DATABASE_URL="pglite://memory";
process.env.NODE_ENV="test";
const original=await import("@/lib/services/inference-credential-revocation");
mock.module("@/lib/services/inference-credential-revocation",()=>({...original,revokeInferenceApiKey:async()=>{}}));
const {dbWrite,closeDatabaseConnectionsForTests}=await import("@/db/client");
const {apiKeysService}=await import("@/lib/services/api-keys");
const {apiKeysRepository}=await import("@/db/repositories/api-keys");
const secret="eliza_"+"b".repeat(64), other="eliza_"+"c".repeat(64);
const id="00000000-0000-4000-8000-0000000000a1";
beforeAll(async()=>{
  await dbWrite.execute(sql`
    CREATE TABLE IF NOT EXISTS api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      description text,
      key_hash text NOT NULL UNIQUE,
      key_prefix text NOT NULL,
      key_ciphertext text, key_nonce text, key_auth_tag text,
      key_kms_key_id text, key_kms_key_version integer,
      organization_id uuid NOT NULL,
      user_id uuid NOT NULL,
      source_app_id uuid,
      rate_limit integer NOT NULL DEFAULT 1000,
      is_active boolean NOT NULL DEFAULT true,
      usage_count integer NOT NULL DEFAULT 0,
      expires_at timestamp,
      last_used_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now(),
      user_created boolean NOT NULL DEFAULT false,
      deleted_at timestamp
    )
  `);
  await dbWrite.execute(sql`
    CREATE TABLE IF NOT EXISTS auth_events (
      event_id uuid PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(),
      actor_type text NOT NULL, actor_id text NOT NULL, action text NOT NULL,
      result text NOT NULL, resource_type text, resource_id text, ip text,
      ua text, request_id text, org_id text, metadata jsonb,
      expires_at timestamptz NOT NULL DEFAULT now() + interval '7 years'
    )
  `);

for (const [key,keyId] of [[secret,id],[other,"00000000-0000-4000-8000-0000000000a2"]]) {
 const hash=createHash("sha256").update(key).digest("hex");
 await dbWrite.execute(sql`INSERT INTO api_keys (id,name,key_hash,key_prefix,organization_id,user_id,key_ciphertext) VALUES (${keyId},'CLI test',${hash},'eliza_', '00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000c1','encrypted')`);
}
},60000);
afterAll(async()=>{await closeDatabaseConnectionsForTests();});
test("rollback, exact-key isolation and durable response-loss receipt",async()=>{
 await expect(apiKeysService.revokePresentedStandardCredential(secret,async()=>{throw Error("audit failure");})).rejects.toThrow("audit failure");
 expect((await apiKeysRepository.findByIdConsistent(id))?.is_active).toBe(true);
 const first=await apiKeysService.revokePresentedStandardCredential(secret);
 const retry=await apiKeysService.revokePresentedStandardCredential(secret);
 expect(first?.revokedNow).toBe(true);expect(retry?.revokedNow).toBe(false);expect(retry?.receipt).toEqual(first?.receipt);
 expect((await apiKeysRepository.findByIdConsistent(id))?.key_ciphertext).toBeNull();
 expect((await apiKeysRepository.findByHashConsistent(createHash("sha256").update(other).digest("hex")))?.is_active).toBe(true);
 expect(await apiKeysService.revokePresentedStandardCredential("eliza_"+"0".repeat(64))).toBeNull();
},60000);
