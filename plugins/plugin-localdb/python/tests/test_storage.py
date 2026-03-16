import os
import shutil
import tempfile
import pytest

from elizaos_plugin_localdb.storage import JSONStorage


@pytest.fixture
def temp_dir():
    dir_path = tempfile.mkdtemp()
    yield dir_path
    shutil.rmtree(dir_path)


@pytest.fixture
def storage(temp_dir):
    return JSONStorage(temp_dir)


@pytest.mark.asyncio
async def test_init(storage, temp_dir):
    await storage.init()
    assert storage.is_ready()
    assert os.path.exists(temp_dir)


@pytest.mark.asyncio
async def test_set_and_get(storage):
    await storage.init()

    data = {"name": "Test", "value": 42}
    await storage.set("items", "item-1", data)

    retrieved = await storage.get("items", "item-1")
    assert retrieved is not None
    assert retrieved["name"] == "Test"
    assert retrieved["value"] == 42


@pytest.mark.asyncio
async def test_get_all(storage):
    await storage.init()

    await storage.set("items", "item-1", {"name": "One"})
    await storage.set("items", "item-2", {"name": "Two"})

    all_items = await storage.get_all("items")
    assert len(all_items) == 2


@pytest.mark.asyncio
async def test_delete(storage):
    await storage.init()

    await storage.set("items", "item-1", {"name": "Test"})
    assert await storage.get("items", "item-1") is not None

    deleted = await storage.delete("items", "item-1")
    assert deleted is True

    assert await storage.get("items", "item-1") is None


@pytest.mark.asyncio
async def test_get_where(storage):
    await storage.init()

    await storage.set("items", "item-1", {"name": "Apple", "type": "fruit"})
    await storage.set("items", "item-2", {"name": "Banana", "type": "fruit"})
    await storage.set("items", "item-3", {"name": "Carrot", "type": "vegetable"})

    fruits = await storage.get_where("items", lambda x: x.get("type") == "fruit")
    assert len(fruits) == 2


@pytest.mark.asyncio
async def test_count(storage):
    await storage.init()

    await storage.set("items", "item-1", {"value": 1})
    await storage.set("items", "item-2", {"value": 2})
    await storage.set("items", "item-3", {"value": 3})

    count = await storage.count("items")
    assert count == 3

    high_count = await storage.count("items", lambda x: x.get("value", 0) > 1)
    assert high_count == 2


@pytest.mark.asyncio
async def test_close(storage):
    await storage.init()
    assert storage.is_ready()

    await storage.close()
    assert not storage.is_ready()
