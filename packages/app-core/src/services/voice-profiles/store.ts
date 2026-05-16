import type { VoiceProfile } from "./types.ts";

export interface VoiceProfileSearchHit {
  profile: VoiceProfile;
  similarity: number;
}

export interface VoiceProfileStore {
  upsert(p: VoiceProfile): Promise<void>;
  get(id: string): Promise<VoiceProfile | null>;
  list(): Promise<VoiceProfile[]>;
  search(
    embedding: ReadonlyArray<number>,
    limit?: number,
  ): Promise<VoiceProfileSearchHit[]>;
  delete(id: string): Promise<void>;
}

function cosineSimilarity(
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>,
): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aMag += av * av;
    bMag += bv * bv;
  }
  const denom = Math.sqrt(aMag) * Math.sqrt(bMag);
  if (denom === 0) return 0;
  return dot / denom;
}

export class InMemoryVoiceProfileStore implements VoiceProfileStore {
  private readonly profiles = new Map<string, VoiceProfile>();

  async upsert(p: VoiceProfile): Promise<void> {
    this.profiles.set(p.id, p);
  }

  async get(id: string): Promise<VoiceProfile | null> {
    return this.profiles.get(id) ?? null;
  }

  async list(): Promise<VoiceProfile[]> {
    return Array.from(this.profiles.values());
  }

  async search(
    embedding: ReadonlyArray<number>,
    limit = 10,
  ): Promise<VoiceProfileSearchHit[]> {
    const hits: VoiceProfileSearchHit[] = [];
    for (const profile of this.profiles.values()) {
      let best = -Infinity;
      for (const e of profile.embeddings) {
        const sim = cosineSimilarity(embedding, e.vectorPreview);
        if (sim > best) best = sim;
      }
      if (best === -Infinity) continue;
      hits.push({ profile, similarity: best });
    }
    hits.sort((a, b) => b.similarity - a.similarity);
    return hits.slice(0, limit);
  }

  async delete(id: string): Promise<void> {
    this.profiles.delete(id);
  }
}
