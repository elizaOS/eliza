from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ActionSpecification(BaseModel):
    name: str
    description: str
    parameters: dict[str, Any] | None = None


class ProviderSpecification(BaseModel):
    name: str
    description: str
    data_structure: dict[str, Any] | None = Field(default=None, alias="dataStructure")

    model_config = {"populate_by_name": True}


class ServiceSpecification(BaseModel):
    name: str
    description: str
    methods: list[str] | None = None


class EvaluatorSpecification(BaseModel):
    name: str
    description: str
    triggers: list[str] | None = None


class EnvironmentVariableSpec(BaseModel):
    name: str
    description: str
    required: bool
    sensitive: bool


class PluginSpecification(BaseModel):
    name: str
    description: str
    version: str = "1.0.0"
    actions: list[ActionSpecification] | None = None
    providers: list[ProviderSpecification] | None = None
    services: list[ServiceSpecification] | None = None
    evaluators: list[EvaluatorSpecification] | None = None
    dependencies: dict[str, str] | None = None
    environment_variables: list[EnvironmentVariableSpec] | None = Field(
        default=None, alias="environmentVariables"
    )

    model_config = {"populate_by_name": True}


class JobError(BaseModel):
    iteration: int
    phase: str
    error: str
    timestamp: datetime


class TestResults(BaseModel):
    passed: int
    failed: int
    duration: float


class PluginCreationJob(BaseModel):
    id: str
    specification: PluginSpecification
    status: JobStatus
    current_phase: str = Field(alias="currentPhase")
    progress: float
    logs: list[str]
    error: str | None = None
    result: str | None = None
    output_path: str = Field(alias="outputPath")
    started_at: datetime = Field(alias="startedAt")
    completed_at: datetime | None = Field(default=None, alias="completedAt")
    current_iteration: int = Field(alias="currentIteration")
    max_iterations: int = Field(alias="maxIterations")
    test_results: TestResults | None = Field(default=None, alias="testResults")
    validation_score: float | None = Field(default=None, alias="validationScore")
    errors: list[JobError]
    model_used: str | None = Field(default=None, alias="modelUsed")

    model_config = {"populate_by_name": True}


class CreatePluginOptions(BaseModel):
    use_template: bool = Field(default=True, alias="useTemplate")
    model: str | None = None

    model_config = {"populate_by_name": True}


class PluginInfo(BaseModel):
    name: str
    id: str | None = None
    status: JobStatus | None = None
    phase: str | None = None
    progress: float | None = None
    started_at: datetime | None = Field(default=None, alias="startedAt")
    completed_at: datetime | None = Field(default=None, alias="completedAt")
    model_used: str | None = Field(default=None, alias="modelUsed")

    model_config = {"populate_by_name": True}


class PluginRegistryData(BaseModel):
    total_created: int = Field(alias="totalCreated")
    plugins: list[PluginInfo]
    active_jobs: int = Field(alias="activeJobs")

    model_config = {"populate_by_name": True}
