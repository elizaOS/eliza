from eliza.v1 import memory_pb2 as _memory_pb2
from eliza.v1 import primitives_pb2 as _primitives_pb2
from eliza.v1 import state_pb2 as _state_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ShouldRespondModelType(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SHOULD_RESPOND_MODEL_TYPE_UNSPECIFIED: _ClassVar[ShouldRespondModelType]
    SHOULD_RESPOND_MODEL_TYPE_NANO: _ClassVar[ShouldRespondModelType]
    SHOULD_RESPOND_MODEL_TYPE_SMALL: _ClassVar[ShouldRespondModelType]
    SHOULD_RESPOND_MODEL_TYPE_LARGE: _ClassVar[ShouldRespondModelType]
    SHOULD_RESPOND_MODEL_TYPE_MEGA: _ClassVar[ShouldRespondModelType]
    SHOULD_RESPOND_MODEL_TYPE_RESPONSE_HANDLER: _ClassVar[ShouldRespondModelType]

class MessageProcessingMode(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    MESSAGE_PROCESSING_MODE_UNSPECIFIED: _ClassVar[MessageProcessingMode]
    MESSAGE_PROCESSING_MODE_SIMPLE: _ClassVar[MessageProcessingMode]
    MESSAGE_PROCESSING_MODE_ACTIONS: _ClassVar[MessageProcessingMode]
    MESSAGE_PROCESSING_MODE_NONE: _ClassVar[MessageProcessingMode]
SHOULD_RESPOND_MODEL_TYPE_UNSPECIFIED: ShouldRespondModelType
SHOULD_RESPOND_MODEL_TYPE_NANO: ShouldRespondModelType
SHOULD_RESPOND_MODEL_TYPE_SMALL: ShouldRespondModelType
SHOULD_RESPOND_MODEL_TYPE_LARGE: ShouldRespondModelType
SHOULD_RESPOND_MODEL_TYPE_MEGA: ShouldRespondModelType
SHOULD_RESPOND_MODEL_TYPE_RESPONSE_HANDLER: ShouldRespondModelType
MESSAGE_PROCESSING_MODE_UNSPECIFIED: MessageProcessingMode
MESSAGE_PROCESSING_MODE_SIMPLE: MessageProcessingMode
MESSAGE_PROCESSING_MODE_ACTIONS: MessageProcessingMode
MESSAGE_PROCESSING_MODE_NONE: MessageProcessingMode

class MessageProcessingOptions(_message.Message):
    __slots__ = ("max_retries", "timeout_duration", "use_multi_step", "max_multi_step_iterations", "should_respond_model")
    MAX_RETRIES_FIELD_NUMBER: _ClassVar[int]
    TIMEOUT_DURATION_FIELD_NUMBER: _ClassVar[int]
    USE_MULTI_STEP_FIELD_NUMBER: _ClassVar[int]
    MAX_MULTI_STEP_ITERATIONS_FIELD_NUMBER: _ClassVar[int]
    SHOULD_RESPOND_MODEL_FIELD_NUMBER: _ClassVar[int]
    max_retries: int
    timeout_duration: int
    use_multi_step: bool
    max_multi_step_iterations: int
    should_respond_model: ShouldRespondModelType
    def __init__(self, max_retries: _Optional[int] = ..., timeout_duration: _Optional[int] = ..., use_multi_step: bool = ..., max_multi_step_iterations: _Optional[int] = ..., should_respond_model: _Optional[_Union[ShouldRespondModelType, str]] = ...) -> None: ...

class MessageProcessingResult(_message.Message):
    __slots__ = ("did_respond", "response_content", "response_messages", "state", "mode")
    DID_RESPOND_FIELD_NUMBER: _ClassVar[int]
    RESPONSE_CONTENT_FIELD_NUMBER: _ClassVar[int]
    RESPONSE_MESSAGES_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    MODE_FIELD_NUMBER: _ClassVar[int]
    did_respond: bool
    response_content: _primitives_pb2.Content
    response_messages: _containers.RepeatedCompositeFieldContainer[_memory_pb2.Memory]
    state: _state_pb2.State
    mode: MessageProcessingMode
    def __init__(self, did_respond: bool = ..., response_content: _Optional[_Union[_primitives_pb2.Content, _Mapping]] = ..., response_messages: _Optional[_Iterable[_Union[_memory_pb2.Memory, _Mapping]]] = ..., state: _Optional[_Union[_state_pb2.State, _Mapping]] = ..., mode: _Optional[_Union[MessageProcessingMode, str]] = ...) -> None: ...

class ResponseDecision(_message.Message):
    __slots__ = ("should_respond", "skip_evaluation", "reason")
    SHOULD_RESPOND_FIELD_NUMBER: _ClassVar[int]
    SKIP_EVALUATION_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    should_respond: bool
    skip_evaluation: bool
    reason: str
    def __init__(self, should_respond: bool = ..., skip_evaluation: bool = ..., reason: _Optional[str] = ...) -> None: ...
