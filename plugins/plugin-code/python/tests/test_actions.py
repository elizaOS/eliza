from __future__ import annotations

from elizaos_plugin_eliza_coder.actions import (
    ChangeDirectoryAction,
    EditFileAction,
    ExecuteShellAction,
    GitAction,
    ListFilesAction,
    ReadFileAction,
    SearchFilesAction,
    WriteFileAction,
)
from elizaos_plugin_eliza_coder.service import CoderService


def _message(text: str) -> dict:
    return {"content": {"text": text}, "room_id": "room-1", "agent_id": "agent-1"}


async def test_write_then_read(service: CoderService) -> None:
    write = WriteFileAction()
    res = await write.handler(_message("write"), {"filepath": "a.txt", "content": "hello"}, service)
    assert res.success

    read = ReadFileAction()
    res2 = await read.handler(_message('"a.txt"'), {}, service)
    assert res2.success
    assert "hello" in res2.text


async def test_edit_file(service: CoderService) -> None:
    write = WriteFileAction()
    await write.handler(_message("write"), {"filepath": "b.txt", "content": "abc"}, service)

    edit = EditFileAction()
    res = await edit.handler(
        _message("edit"),
        {"filepath": "b.txt", "old_str": "b", "new_str": "B"},
        service,
    )
    assert res.success

    read = ReadFileAction()
    res2 = await read.handler(_message('"b.txt"'), {}, service)
    assert "aBc" in res2.text


async def test_list_files(service: CoderService) -> None:
    write = WriteFileAction()
    await write.handler(_message("write"), {"filepath": "c.txt", "content": "x"}, service)

    ls = ListFilesAction()
    res = await ls.handler(_message("list"), {"path": "."}, service)
    assert res.success
    assert "c.txt" in res.text


async def test_search_files(service: CoderService) -> None:
    write = WriteFileAction()
    await write.handler(_message("write"), {"filepath": "d.txt", "content": "needle here"}, service)

    search = SearchFilesAction()
    res = await search.handler(
        _message("search"),
        {"pattern": "needle", "path": ".", "max_matches": 50},
        service,
    )
    assert res.success
    assert "d.txt" in res.text


async def test_change_directory_rejects_escape(service: CoderService) -> None:
    cd = ChangeDirectoryAction()
    res = await cd.handler(_message("cd"), {"path": ".."}, service)
    assert not res.success


async def test_execute_shell_pwd(service: CoderService) -> None:
    sh = ExecuteShellAction()
    res = await sh.handler(_message("shell"), {"command": "pwd"}, service)
    assert res.success


async def test_git_requires_repo(service: CoderService) -> None:
    g = GitAction()
    res = await g.handler(_message("git"), {"args": "status"}, service)
    assert not res.success
