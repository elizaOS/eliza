
import asyncio
from pathlib import PurePath
from typing import Any

from swerex.deployment.abstract import AbstractDeployment
from swerex.runtime.abstract import (
    AbstractRuntime,
    BashAction,
    BashInterruptAction,
    Command,
    CreateBashSessionRequest,
    ReadFileRequest,
    WriteFileRequest,
)

# We can't import ProviderTaskExecutionContext directly as it is in the benchmark code,
# so we will treat it as Any / duck-typed.



from dataclasses import dataclass

@dataclass
class BashActionResult:
    output: str
    exit_code: int

@dataclass
class ReadFileResult:
    content: str


class OrchestratorRuntime(AbstractRuntime):
    def __init__(self, ctx: Any):
        super().__init__()
        self.ctx = ctx

    async def run_in_session(self, action: BashAction | BashInterruptAction) -> Any:
        if isinstance(action, BashInterruptAction):
            return None

        if isinstance(action, BashAction):
            tool_name = "shell"
            tool_input = {"command": action.command}
            
            success, output = await self.ctx.execute_tool(tool_name, tool_input)
            
            exit_code = 0 if success else 1
            
            return BashActionResult(output=output, exit_code=exit_code)

        raise NotImplementedError(f"Action {type(action)} not supported")

    async def create_session(self, request: CreateBashSessionRequest) -> None:
        pass

    async def close(self) -> None:
        pass

    async def execute(self, command: Command) -> Any:
        await self.run_in_session(BashAction(command=command.command, timeout=command.timeout))

    async def read_file(self, request: ReadFileRequest) -> Any:
        tool_name = "read_file"
        tool_input = {"file_path": request.path} 
        
        success, output = await self.ctx.execute_tool(tool_name, tool_input)
        
        if not success:
            raise FileNotFoundError(output)
            
        return ReadFileResult(content=output)

    async def write_file(self, request: WriteFileRequest) -> Any:
        tool_name = "write_file"
        tool_input = {"file_path": request.path, "content": request.content}
        
        success, output = await self.ctx.execute_tool(tool_name, tool_input)
        
        if not success:
            raise RuntimeError(f"Failed to write file: {output}")

    async def close_session(self) -> None:
        pass

    async def upload(self, src: str | PurePath, dst: str | PurePath) -> None:
        pass

    @property
    def is_alive(self) -> bool:
        return True



class OrchestratorDeployment(AbstractDeployment):
    def __init__(self, ctx: Any):
        super().__init__()
        self._runtime = OrchestratorRuntime(ctx)

    @property
    def runtime(self) -> AbstractRuntime:
        return self._runtime

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass

    def add_hook(self, hook: Any) -> None:
        # Hooks not currently supported for OrchestratorDeployment
        pass

    async def is_alive(self, timeout: float | None = None) -> bool:
        # Orchestrator manages lifecycle, assume alive if we are running
        return True
