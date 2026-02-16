import asyncio
import unittest
from unittest.mock import MagicMock, AsyncMock, ANY
from elizaos.runtime import AgentRuntime, RuntimeSettings
from elizaos.types.database import IDatabaseAdapter
from elizaos.types.service import Service
from elizaos.types.memory import Memory
from elizaos.types.environment import Entity, Room, World
from elizaos.types.model import ModelType, GenerateTextOptions

class MockTrajectoryLogger(Service):
    def __init__(self):
        self.logs = []
        self.provider_logs = []
        
    @property
    def capability_description(self):
        return "Mock Trajectory Logger"
        
    async def stop(self):
        pass

    def log_llm_call(self, **kwargs):
        self.logs.append(kwargs)
        return "log_id"

    def log_provider_access(self, **kwargs):
        self.provider_logs.append(kwargs)

class TestTrajectoryPipeline(unittest.IsolatedAsyncioTestCase):
    async def test_parity_logging(self):
        # 1. Setup Runtime
        mock_db = MagicMock(spec=IDatabaseAdapter)
        settings = RuntimeSettings(
            model_provider="mock",
            token="mock",
            agent_id="00000000-0000-0000-0000-000000000000"
        )
        
        runtime = AgentRuntime(
            settings=settings,
            adapter=mock_db,
            character=MagicMock(),
        )
        
        # Mock providers
        mock_provider = AsyncMock()
        mock_provider.name = "test_provider"
        mock_provider.private = False
        mock_provider.get.return_value = MagicMock(text="some text content", values={}, data={})
        runtime._providers = [mock_provider]
        
        # Register Mock Trajectory Logger
        logger_service = MockTrajectoryLogger()
        # Manually inject service since register_service expects a class and does async start
        runtime._services["trajectory_logger"] = [logger_service]
        
        # 2. Test compose_state phase logging
        step_id = "test_step_123"
        message = Memory(
            id="11111111-1111-1111-1111-111111111111",
            content={"text": "hello"},
            room_id="22222222-2222-2222-2222-222222222222",
            entity_id="33333333-3333-3333-3333-333333333333",
            agent_id="00000000-0000-0000-0000-000000000000",
            metadata={"message": {"trajectory_step_id": step_id}}
        )
        
        # Call compose_state with phase
        await runtime.compose_state(
            message=message,
            trajectory_phase="generate"
        )
        
        # Verify provider logs
        self.assertTrue(len(logger_service.provider_logs) > 0)
        log = logger_service.provider_logs[0]
        self.assertEqual(log["step_id"], step_id)
        self.assertEqual(log["purpose"], "compose_state:generate")
        self.assertIn("textLength", log["data"])
        
        # 3. Test use_model embedding truncation
        # Mock handle_model call inside use_model? use_model calls self.model_provider...
        # We can bypass use_model logic by mocking the handler but use_model logic creates the log entry.
        # But use_model logic is what we want to test (truncation).
        
        # Mock the model handler
        async def mock_handler(*args, **kwargs):
            return "[" + "0.1, " * 100 + "0.1]"
            
        runtime.register_model(ModelType.TEXT_EMBEDDING, mock_handler, "mock_provider")
        
        # Set context var or pass step_id some way? use_model reads CURRENT_TRAJECTORY_STEP_ID
        from elizaos.trajectory_context import bind_trajectory_step
        
        with bind_trajectory_step(step_id):
            await runtime.use_model(
                ModelType.TEXT_EMBEDDING,
                prompt="test prompt"
            )
            
        # Verify LLM logs
        self.assertTrue(len(logger_service.logs) > 0)
        llm_log = logger_service.logs[0]
        self.assertEqual(llm_log["step_id"], step_id)
        self.assertEqual(llm_log["response"], "[embedding vector dim=101]")
        
        print("\n✅ Python Trajectory Parity Tests Passed!")

if __name__ == "__main__":
    unittest.main()
