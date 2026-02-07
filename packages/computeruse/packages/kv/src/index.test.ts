import * as fs from 'fs';
import * as path from 'path';
import { createClient, KVClient } from './index';

const TEST_FILE_DB = path.resolve(__dirname, '../test-kv.json');

// Helper to run standard suite against any adapter
function runKVTestSuite(name: string, clientFactory: () => Promise<KVClient> | KVClient, cleanup?: () => Promise<void>) {
  describe(`KV Adapter: ${name}`, () => {
    let client: KVClient;

    beforeAll(async () => {
      client = await clientFactory();
    });

    afterAll(async () => {
      await client.disconnect();
      if (cleanup) await cleanup();
    });

    it('should set and get a value', async () => {
      const key = `test:${name}:key1`;
      await client.set(key, 'value1');
      const val = await client.get(key);
      expect(val).toBe('value1');
    });

    it('should return null for non-existent key', async () => {
      const val = await client.get(`test:${name}:nonexistent`);
      expect(val).toBeNull();
    });

    it('should delete a key', async () => {
      const key = `test:${name}:del`;
      await client.set(key, 'foo');
      expect(await client.get(key)).toBe('foo');
      await client.del(key);
      expect(await client.get(key)).toBeNull();
    });

    it('should handle set NX (not exists)', async () => {
      const key = `test:${name}:nx`;
      await client.del(key);

      // First set should work
      const res1 = await client.set(key, '1', { nx: true });
      expect(res1).toBe('OK');

      // Second set should fail
      const res2 = await client.set(key, '2', { nx: true });
      expect(res2).toBeNull();

      expect(await client.get(key)).toBe('1');
    });

    it('should handle set XX (already exists)', async () => {
      const key = `test:${name}:xx`;
      await client.del(key);

      // Should fail if not exists
      const res1 = await client.set(key, '1', { xx: true });
      expect(res1).toBeNull();

      await client.set(key, '1');

      // Should work if exists
      const res2 = await client.set(key, '2', { xx: true });
      expect(res2).toBe('OK');

      expect(await client.get(key)).toBe('2');
    });

    it('should handle expiration (EX)', async () => {
        const key = `test:${name}:ex`;
        // 1 second expiration
        await client.set(key, 'expired', { ex: 1 });
        expect(await client.get(key)).toBe('expired');

        // Wait 1.1s
        await new Promise(resolve => setTimeout(resolve, 1100));
        expect(await client.get(key)).toBeNull();
    });

    it('should handle integers and incr', async () => {
        const key = `test:${name}:incr`;
        await client.del(key);

        await client.incr(key); // 1
        expect(await client.get(key)).toBe('1');

        await client.incr(key); // 2
        expect(await client.get(key)).toBe('2');
    });

    it('should handle lists', async () => {
        const key = `test:${name}:list`;
        await client.del(key);

        await client.lpush(key, 'a');
        await client.lpush(key, 'b'); // list: b, a

        await client.rpush(key, 'c'); // list: b, a, c

        expect(await client.lpop(key)).toBe('b');
        expect(await client.rpop(key)).toBe('c');
        expect(await client.lpop(key)).toBe('a');
        expect(await client.lpop(key)).toBeNull();
    });

    it('should handle hashes', async () => {
        const key = `test:${name}:hash`;
        await client.del(key);

        await client.hset(key, 'f1', 'v1');
        await client.hset(key, { f2: 'v2', f3: 3 });

        expect(await client.hget(key, 'f1')).toBe('v1');
        expect(await client.hget(key, 'f2')).toBe('v2');

        const all = await client.hgetall(key);
        expect(all).toEqual({ f1: 'v1', f2: 'v2', f3: '3' });

        await client.hincrby(key, 'f3', 2); // 3 + 2 = 5
        expect(await client.hget(key, 'f3')).toBe('5');
    });
  });
}

// 1. Test Memory Adapter
runKVTestSuite('Memory', () => createClient({ backend: 'memory' }));

// 2. Test File Adapter
runKVTestSuite('File',
  () => {
    // Clean up before start
    if (fs.existsSync(TEST_FILE_DB)) fs.unlinkSync(TEST_FILE_DB);
    if (fs.existsSync(TEST_FILE_DB + '.lock')) fs.unlinkSync(TEST_FILE_DB + '.lock');
    return createClient({ backend: 'file', url: `file://${TEST_FILE_DB}` });
  },
  async () => {
     // Cleanup
     if (fs.existsSync(TEST_FILE_DB)) fs.unlinkSync(TEST_FILE_DB);
     if (fs.existsSync(TEST_FILE_DB + '.lock')) fs.unlinkSync(TEST_FILE_DB + '.lock');
  }
);

// 3. Test File Persistence specifically
describe('FileKV Persistence', () => {
    const DB_PATH = path.resolve(__dirname, '../test-persistence.json');

    afterEach(() => {
        if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    });

    it('should persist data between client instances', async () => {
        const client1 = createClient({ url: `file://${DB_PATH}` });
        await client1.set('foo', 'bar');
        await client1.disconnect();

        const client2 = createClient({ url: `file://${DB_PATH}` });
        const val = await client2.get('foo');
        expect(val).toBe('bar');
        await client2.disconnect();
    });
});

// 4. Test Factory Logic
describe('createClient factory', () => {
    it('should return MemoryKV for memory protocol', () => {
        const c = createClient({ url: 'memory://' });
        expect(c.constructor.name).toBe('MemoryKV');
    });

    it('should return FileKV for file protocol', () => {
        const c = createClient({ url: 'file://./foo.json' });
        expect(c.constructor.name).toBe('FileKV');
    });
});
