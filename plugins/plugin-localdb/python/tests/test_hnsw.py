import pytest
from elizaos_plugin_localdb.hnsw import SimpleHNSW, cosine_distance


@pytest.mark.asyncio
async def test_init():
    hnsw = SimpleHNSW()
    await hnsw.init(3)
    assert hnsw.dimension == 3
    assert hnsw.size() == 0


@pytest.mark.asyncio
async def test_add_and_search():
    hnsw = SimpleHNSW()
    await hnsw.init(3)

    await hnsw.add("v1", [1.0, 0.0, 0.0])
    await hnsw.add("v2", [0.0, 1.0, 0.0])
    await hnsw.add("v3", [0.9, 0.1, 0.0])

    assert hnsw.size() == 3

    results = await hnsw.search([1.0, 0.0, 0.0], k=2, threshold=0.5)
    assert len(results) >= 1
    assert results[0].id == "v1"
    assert results[0].similarity > 0.9


@pytest.mark.asyncio
async def test_exact_match():
    hnsw = SimpleHNSW()
    await hnsw.init(3)

    await hnsw.add("v1", [1.0, 0.0, 0.0])

    results = await hnsw.search([1.0, 0.0, 0.0], k=1, threshold=0.99)
    assert len(results) == 1
    assert results[0].id == "v1"
    assert results[0].similarity >= 0.99


@pytest.mark.asyncio
async def test_threshold():
    hnsw = SimpleHNSW()
    await hnsw.init(3)

    await hnsw.add("v1", [1.0, 0.0, 0.0])
    await hnsw.add("v2", [0.0, 1.0, 0.0])  # Orthogonal

    results = await hnsw.search([1.0, 0.0, 0.0], k=2, threshold=0.9)
    # Only v1 should pass the high threshold
    assert len(results) == 1
    assert results[0].id == "v1"


@pytest.mark.asyncio
async def test_remove():
    hnsw = SimpleHNSW()
    await hnsw.init(3)

    await hnsw.add("v1", [1.0, 0.0, 0.0])
    await hnsw.add("v2", [0.0, 1.0, 0.0])

    await hnsw.remove("v1")

    assert hnsw.size() == 1

    results = await hnsw.search([1.0, 0.0, 0.0], k=2, threshold=0.0)
    assert all(r.id != "v1" for r in results)


@pytest.mark.asyncio
async def test_update():
    hnsw = SimpleHNSW()
    await hnsw.init(3)

    await hnsw.add("v1", [1.0, 0.0, 0.0])
    await hnsw.add("v1", [0.0, 1.0, 0.0])

    assert hnsw.size() == 1

    results = await hnsw.search([0.0, 1.0, 0.0], k=1, threshold=0.9)
    assert results[0].id == "v1"


@pytest.mark.asyncio
async def test_empty_search():
    hnsw = SimpleHNSW()
    await hnsw.init(3)

    results = await hnsw.search([1.0, 0.0, 0.0], k=10, threshold=0.0)
    assert len(results) == 0


@pytest.mark.asyncio
async def test_dimension_mismatch():
    hnsw = SimpleHNSW()
    await hnsw.init(3)

    with pytest.raises(ValueError, match="dimension mismatch"):
        await hnsw.add("v1", [1.0, 0.0])


@pytest.mark.asyncio
async def test_serialization():
    hnsw = SimpleHNSW()
    await hnsw.init(3)

    await hnsw.add("v1", [1.0, 0.0, 0.0])
    await hnsw.add("v2", [0.0, 1.0, 0.0])

    index = hnsw.get_index()
    hnsw2 = SimpleHNSW()
    hnsw2._load_from_dict(index)

    assert hnsw2.size() == 2

    results = await hnsw2.search([1.0, 0.0, 0.0], k=1, threshold=0.9)
    assert results[0].id == "v1"


def test_cosine_distance():
    assert cosine_distance([1.0, 0.0], [1.0, 0.0]) < 0.001
    assert abs(cosine_distance([1.0, 0.0], [0.0, 1.0]) - 1.0) < 0.001
    assert cosine_distance([1.0, 0.0], [-1.0, 0.0]) > 1.9
