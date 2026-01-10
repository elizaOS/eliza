"""
Autonomy Service for elizaOS - Python implementation.

Provides autonomous operation loop for agents.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import TYPE_CHECKING

from elizaos.types.environment import ChannelType, Room, World
from elizaos.types.events import EventType
from elizaos.types.memory import Memory
from elizaos.types.primitives import UUID, as_uuid, Content
from elizaos.types.service import Service

from .types import AutonomyStatus

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime

# Create a module-level logger for use when runtime is not available
_logger = logging.getLogger(__name__)

AUTONOMY_SERVICE_TYPE = "AUTONOMY"


class AutonomyService(Service):
    """
    AutonomyService - Manages autonomous agent operation.
    
    This service runs an autonomous loop that triggers agent thinking
    in a dedicated room context, separate from user conversations.
    """
    
    service_type = AUTONOMY_SERVICE_TYPE
    
    def __init__(self) -> None:
        """Initialize the autonomy service."""
        self._runtime: IAgentRuntime | None = None
        self._is_running = False
        self._is_thinking = False  # Guard to prevent overlapping think cycles
        self._is_stopped = False  # Flag to indicate service has been stopped
        self._interval_ms = 30000
        self._loop_task: asyncio.Task[None] | None = None
        self._settings_monitor_task: asyncio.Task[None] | None = None
        self._autonomous_room_id = as_uuid(str(uuid.uuid4()))
        self._autonomous_world_id = as_uuid("00000000-0000-0000-0000-000000000001")
    
    def _log(self, level: str, msg: str) -> None:
        """Helper to log with agent context."""
        if self._runtime:
            agent_id = str(self._runtime.agent_id)
            full_msg = f"[autonomy] {msg} (agent={agent_id})"
            getattr(self._runtime.logger, level)(full_msg)
        else:
            getattr(_logger, level)(f"[autonomy] {msg}")
    
    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> "AutonomyService":
        """Start the autonomy service."""
        service = cls()
        service._runtime = runtime
        await service._initialize()
        return service
    
    async def _initialize(self) -> None:
        """Initialize the service."""
        if not self._runtime:
            return
            
        self._log("info", f"Using autonomous room ID: {self._autonomous_room_id}")
        
        # Check settings for auto-start
        autonomy_enabled = self._runtime.get_setting("AUTONOMY_ENABLED")
        
        # Ensure autonomous world and room exist
        await self._ensure_autonomous_context()
        
        self._log("info", f"Settings check - AUTONOMY_ENABLED: {autonomy_enabled}")
        
        # Start if enabled
        if autonomy_enabled is True or autonomy_enabled == "true":
            self._log("info", "Autonomy is enabled in settings, starting...")
            await self.start_loop()
        else:
            self._log("info", "Autonomy disabled by default - will wait for explicit activation")
        
        # Start settings monitoring
        self._settings_monitor_task = asyncio.create_task(self._settings_monitoring())
    
    async def _ensure_autonomous_context(self) -> None:
        """Ensure autonomous world and room exist."""
        if not self._runtime:
            return
        
        try:
            # Ensure world exists
            world = World(
                id=self._autonomous_world_id,
                name="Autonomy World",
                agentId=self._runtime.agent_id,
                messageServerId=as_uuid("00000000-0000-0000-0000-000000000000"),
                metadata={
                    "type": "autonomy",
                    "description": "World for autonomous agent thinking",
                },
            )
            await self._runtime.ensure_world_exists(world)
            
            # Ensure room exists (use SELF channel type for internal agent thoughts)
            room = Room(
                id=self._autonomous_room_id,
                name="Autonomous Thoughts",
                worldId=self._autonomous_world_id,
                source="autonomy-service",
                type=ChannelType.SELF,  # Internal agent monologue
                metadata={
                    "source": "autonomy-service",
                    "description": "Room for autonomous agent thinking",
                },
            )
            await self._runtime.ensure_room_exists(room)
            
            # Add agent as participant
            await self._runtime.add_participant(self._runtime.agent_id, self._autonomous_room_id)
            
            self._log("debug", f"Ensured autonomous room exists with world ID: {self._autonomous_world_id}")
        except Exception as e:
            self._log("error", f"Failed to ensure autonomous context: {e}")
            raise  # Re-throw to prevent service from starting in broken state
    
    async def _settings_monitoring(self) -> None:
        """Monitor settings for autonomy state changes."""
        while not self._is_stopped:
            await asyncio.sleep(10)  # Check every 10 seconds
            
            if not self._runtime or self._is_stopped:
                break
            
            try:
                autonomy_enabled = self._runtime.get_setting("AUTONOMY_ENABLED")
                should_be_running = autonomy_enabled is True or autonomy_enabled == "true"
                
                if should_be_running and not self._is_running:
                    self._log("info", "Settings indicate autonomy should be enabled, starting...")
                    await self.start_loop()
                elif not should_be_running and self._is_running:
                    self._log("info", "Settings indicate autonomy should be disabled, stopping...")
                    await self.stop_loop()
            except Exception as e:
                self._log("error", f"Error in settings monitoring: {e}")
    
    async def start_loop(self) -> None:
        """Start the autonomous loop."""
        if self._is_running:
            return
            
        self._is_running = True
        
        if self._runtime:
            self._runtime.set_setting("AUTONOMY_ENABLED", True)
            self._log("info", f"Starting autonomous loop ({self._interval_ms}ms interval)")
        
        self._loop_task = asyncio.create_task(self._run_loop())
    
    async def stop_loop(self) -> None:
        """Stop the autonomous loop."""
        if not self._is_running:
            return
            
        self._is_running = False
        
        if self._loop_task:
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
            self._loop_task = None
        
        if self._runtime:
            self._runtime.set_setting("AUTONOMY_ENABLED", False)
            self._log("info", "Stopped autonomous loop")
    
    async def _run_loop(self) -> None:
        """Run the autonomous thinking loop."""
        while self._is_running and not self._is_stopped:
            # Guard: Skip if previous iteration is still running
            if self._is_thinking:
                self._log("debug", "Previous autonomous think still in progress, skipping this iteration")
                await asyncio.sleep(self._interval_ms / 1000)
                continue
            
            # Guard: Don't run if stopped while waiting
            if self._is_stopped or not self._is_running:
                break
            
            self._is_thinking = True
            try:
                await self._perform_autonomous_think()
            except Exception as e:
                self._log("error", f"Error in autonomous think: {e}")
            finally:
                self._is_thinking = False
            
            await asyncio.sleep(self._interval_ms / 1000)
    
    def is_thinking_in_progress(self) -> bool:
        """Check if currently processing an autonomous thought."""
        return self._is_thinking
    
    async def _perform_autonomous_think(self) -> None:
        """Perform one iteration of autonomous thinking."""
        if not self._runtime:
            return
            
        self._log("debug", "Performing autonomous thinking...")
        
        # Get agent entity
        agent_entity = await self._runtime.get_entity_by_id(self._runtime.agent_id)
        if not agent_entity:
            self._log("error", "Failed to get agent entity, skipping autonomous thought")
            return
        
        # Get recent autonomous memories
        last_thought: str | None = None
        is_first_thought = False
        
        recent_memories = await self._runtime.get_memories({
            "roomId": self._autonomous_room_id,
            "count": 3,
            "tableName": "memories",
        })
        
        last_agent_thought = None
        for m in sorted(recent_memories, key=lambda x: x.created_at or 0, reverse=True):
            if (
                m.entityId == agent_entity.id
                and m.content
                and m.content.text
                and m.content.metadata
                and m.content.metadata.get("isAutonomous") is True
            ):
                last_agent_thought = m
                break
        
        if last_agent_thought and last_agent_thought.content and last_agent_thought.content.text:
            last_thought = last_agent_thought.content.text
        else:
            is_first_thought = True
        
        # Create monologue prompt
        monologue_prompt = self._create_monologue_prompt(last_thought, is_first_thought)
        
        # Create autonomous message
        entity_id = agent_entity.id if agent_entity.id else self._runtime.agent_id
        autonomous_message = Memory(
            id=as_uuid(str(uuid.uuid4())),
            entityId=as_uuid(str(entity_id)),
            content=Content(text=monologue_prompt, source="autonomous-trigger"),
            roomId=self._autonomous_room_id,
            agentId=self._runtime.agent_id,
            createdAt=int(asyncio.get_event_loop().time() * 1000),
        )
        
        self._log("debug", "Processing autonomous message through agent pipeline...")
        
        # Emit message event
        async def callback(content: Content) -> None:
            if self._runtime:
                self._log("debug", f"Response generated: {(content.text or '')[:100]}...")
                
                if content.text:
                    response_memory = Memory(
                        id=as_uuid(str(uuid.uuid4())),
                        entityId=as_uuid(str(entity_id)),
                        agentId=self._runtime.agent_id,
                        content=Content(text=content.text, source=content.source or "autonomous"),
                        roomId=self._autonomous_room_id,
                        createdAt=int(asyncio.get_event_loop().time() * 1000),
                    )
                    
                    await self._runtime.create_memory(response_memory, "messages")
        
        await self._runtime.emit_event(
            EventType.MESSAGE_RECEIVED.value,
            {
                "runtime": self._runtime,
                "message": autonomous_message,
                "callback": callback,
            },
        )
    
    def _create_monologue_prompt(self, last_thought: str | None, is_first_thought: bool) -> str:
        """Create an introspective monologue prompt."""
        if is_first_thought:
            return """As an AI agent, reflect on your current state and experiences. What are you thinking about right now? What interests you or concerns you? Share your internal thoughts as a stream of consciousness. Don't address anyone - this is your private monologue.

Generate a thoughtful, introspective response (1-2 sentences):"""
        
        return f"""Continuing your internal monologue from your last thought: "{last_thought}"

What naturally follows from this thought? What does it make you think about next? Continue your stream of consciousness without addressing anyone - this is your private internal reflection.

Generate your next thought (1-2 sentences):"""
    
    # Public API methods
    
    def is_loop_running(self) -> bool:
        """Check if loop is currently running."""
        return self._is_running
    
    def get_loop_interval(self) -> int:
        """Get current loop interval in milliseconds."""
        return self._interval_ms
    
    def set_loop_interval(self, ms: int) -> None:
        """Set loop interval (takes effect on next iteration)."""
        MIN_INTERVAL = 5000
        MAX_INTERVAL = 600000
        
        if ms < MIN_INTERVAL:
            self._log("warning", f"Interval too short, minimum is {MIN_INTERVAL}ms")
            ms = MIN_INTERVAL
        if ms > MAX_INTERVAL:
            self._log("warning", f"Interval too long, maximum is {MAX_INTERVAL}ms")
            ms = MAX_INTERVAL
        
        self._interval_ms = ms
        self._log("info", f"Loop interval set to {ms}ms")
    
    def get_autonomous_room_id(self) -> UUID:
        """Get the autonomous room ID."""
        return self._autonomous_room_id
    
    async def enable_autonomy(self) -> None:
        """Enable autonomy."""
        if self._runtime:
            self._runtime.set_setting("AUTONOMY_ENABLED", True)
        if not self._is_running:
            await self.start_loop()
    
    async def disable_autonomy(self) -> None:
        """Disable autonomy."""
        if self._runtime:
            self._runtime.set_setting("AUTONOMY_ENABLED", False)
        if self._is_running:
            await self.stop_loop()
    
    def get_status(self) -> AutonomyStatus:
        """Get current autonomy status."""
        enabled = False
        if self._runtime:
            setting = self._runtime.get_setting("AUTONOMY_ENABLED")
            enabled = setting is True or setting == "true"
        
        return AutonomyStatus(
            enabled=enabled,
            running=self._is_running,
            thinking=self._is_thinking,
            interval=self._interval_ms,
            autonomous_room_id=str(self._autonomous_room_id),
        )
    
    async def stop(self) -> None:
        """Stop the service."""
        # Mark as stopped to prevent new operations
        self._is_stopped = True
        
        # Stop the autonomous loop
        await self.stop_loop()
        
        # Clean up settings monitoring
        if self._settings_monitor_task:
            self._settings_monitor_task.cancel()
            try:
                await self._settings_monitor_task
            except asyncio.CancelledError:
                pass
            self._settings_monitor_task = None
        
        self._log("info", "Autonomy service stopped completely")
    
    @property
    def capability_description(self) -> str:
        """Get capability description."""
        return "Autonomous operation loop for continuous agent thinking and actions"
