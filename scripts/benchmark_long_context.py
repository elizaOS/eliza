
import asyncio
import uuid
import random
import time
from typing import List

from elizaos.advanced_memory.memory_service import MemoryService
from elizaos.advanced_memory.types import LongTermMemoryCategory, LongTermMemory
from elizaos.types.primitives import as_uuid

async def run_benchmark():
    print("Starting Advanced Memory 'Needle in a Haystack' Benchmark...")
    
    # Initialize Service
    service = MemoryService(runtime=None)
    
    # Configuration
    agent_id = as_uuid(uuid.uuid4())
    entity_id = as_uuid(uuid.uuid4())
    
    needle_content = "The secret code is ALPHA-BETA-GAMMA."
    
    # Benchmark scenarios
    scenarios = [10, 100, 1000, 5000]
    
    print(f"{'Items':<10} | {'Found':<10} | {'Rank':<10} | {'Confidence':<10} | {'Time (ms)':<10}")
    print("-" * 60)

    for num_distractors in scenarios:
        # 1. Reset Logic (simulated by clearing local dict for this entity)
        service._long_term.clear()
        
        # 2. Insert Distractors
        distractors = []
        for i in range(num_distractors):
            # Random confidence between 0.1 and 0.8
            conf = random.uniform(0.1, 0.8)
            await service.store_long_term_memory(
                agent_id=agent_id,
                entity_id=entity_id,
                category=LongTermMemoryCategory.SEMANTIC,
                content=f"Distractor fact number {i}",
                confidence=conf
            )
            
        # 3. Insert Needle (High confidence)
        # We give it 0.95 confidence so it should theoretically appear at the top
        await service.store_long_term_memory(
            agent_id=agent_id,
            entity_id=entity_id,
            category=LongTermMemoryCategory.SEMANTIC,
            content=needle_content,
            confidence=0.95
        )
        
        # 4. Retrieval Benchmark
        start_time = time.time()
        # Retrieve top 5 memories
        memories: List[LongTermMemory] = await service.get_long_term_memories(entity_id, limit=5)
        duration_ms = (time.time() - start_time) * 1000
        
        # 5. Verification
        found = False
        rank = -1
        found_conf = 0.0
        
        for idx, mem in enumerate(memories):
            if mem.content == needle_content:
                found = True
                rank = idx + 1
                found_conf = mem.confidence
                break
        
        print(f"{num_distractors:<10} | {str(found):<10} | {rank:<10} | {found_conf:<10.2f} | {duration_ms:<10.2f}")

    print("\nBenchmark Complete.")

if __name__ == "__main__":
    asyncio.run(run_benchmark())
