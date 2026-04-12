from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class LLMMode(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    LLM_MODE_UNSPECIFIED: _ClassVar[LLMMode]
    LLM_MODE_DEFAULT: _ClassVar[LLMMode]
    LLM_MODE_SMALL: _ClassVar[LLMMode]
    LLM_MODE_LARGE: _ClassVar[LLMMode]

class ModelType(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    MODEL_TYPE_UNSPECIFIED: _ClassVar[ModelType]
    MODEL_TYPE_TEXT_SMALL: _ClassVar[ModelType]
    MODEL_TYPE_TEXT_LARGE: _ClassVar[ModelType]
    MODEL_TYPE_TEXT_EMBEDDING: _ClassVar[ModelType]
    MODEL_TYPE_TEXT_TOKENIZER_ENCODE: _ClassVar[ModelType]
    MODEL_TYPE_TEXT_TOKENIZER_DECODE: _ClassVar[ModelType]
    MODEL_TYPE_TEXT_COMPLETION: _ClassVar[ModelType]
    MODEL_TYPE_IMAGE: _ClassVar[ModelType]
    MODEL_TYPE_IMAGE_DESCRIPTION: _ClassVar[ModelType]
    MODEL_TYPE_TRANSCRIPTION: _ClassVar[ModelType]
    MODEL_TYPE_TEXT_TO_SPEECH: _ClassVar[ModelType]
    MODEL_TYPE_AUDIO: _ClassVar[ModelType]
    MODEL_TYPE_VIDEO: _ClassVar[ModelType]
    MODEL_TYPE_OBJECT_SMALL: _ClassVar[ModelType]
    MODEL_TYPE_OBJECT_LARGE: _ClassVar[ModelType]
    MODEL_TYPE_TEXT_NANO: _ClassVar[ModelType]
    MODEL_TYPE_TEXT_MEDIUM: _ClassVar[ModelType]
    MODEL_TYPE_TEXT_MEGA: _ClassVar[ModelType]
    MODEL_TYPE_RESPONSE_HANDLER: _ClassVar[ModelType]
    MODEL_TYPE_ACTION_PLANNER: _ClassVar[ModelType]
    MODEL_TYPE_RESEARCH: _ClassVar[ModelType]
LLM_MODE_UNSPECIFIED: LLMMode
LLM_MODE_DEFAULT: LLMMode
LLM_MODE_SMALL: LLMMode
LLM_MODE_LARGE: LLMMode
MODEL_TYPE_UNSPECIFIED: ModelType
MODEL_TYPE_TEXT_SMALL: ModelType
MODEL_TYPE_TEXT_LARGE: ModelType
MODEL_TYPE_TEXT_EMBEDDING: ModelType
MODEL_TYPE_TEXT_TOKENIZER_ENCODE: ModelType
MODEL_TYPE_TEXT_TOKENIZER_DECODE: ModelType
MODEL_TYPE_TEXT_COMPLETION: ModelType
MODEL_TYPE_IMAGE: ModelType
MODEL_TYPE_IMAGE_DESCRIPTION: ModelType
MODEL_TYPE_TRANSCRIPTION: ModelType
MODEL_TYPE_TEXT_TO_SPEECH: ModelType
MODEL_TYPE_AUDIO: ModelType
MODEL_TYPE_VIDEO: ModelType
MODEL_TYPE_OBJECT_SMALL: ModelType
MODEL_TYPE_OBJECT_LARGE: ModelType
MODEL_TYPE_TEXT_NANO: ModelType
MODEL_TYPE_TEXT_MEDIUM: ModelType
MODEL_TYPE_TEXT_MEGA: ModelType
MODEL_TYPE_RESPONSE_HANDLER: ModelType
MODEL_TYPE_ACTION_PLANNER: ModelType
MODEL_TYPE_RESEARCH: ModelType

class ResponseFormat(_message.Message):
    __slots__ = ("type",)
    TYPE_FIELD_NUMBER: _ClassVar[int]
    type: str
    def __init__(self, type: _Optional[str] = ...) -> None: ...

class GenerateTextParams(_message.Message):
    __slots__ = ("prompt", "max_tokens", "min_tokens", "temperature", "top_p", "top_k", "min_p", "seed", "repetition_penalty", "frequency_penalty", "presence_penalty", "stop_sequences", "user", "response_format", "stream")
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    MAX_TOKENS_FIELD_NUMBER: _ClassVar[int]
    MIN_TOKENS_FIELD_NUMBER: _ClassVar[int]
    TEMPERATURE_FIELD_NUMBER: _ClassVar[int]
    TOP_P_FIELD_NUMBER: _ClassVar[int]
    TOP_K_FIELD_NUMBER: _ClassVar[int]
    MIN_P_FIELD_NUMBER: _ClassVar[int]
    SEED_FIELD_NUMBER: _ClassVar[int]
    REPETITION_PENALTY_FIELD_NUMBER: _ClassVar[int]
    FREQUENCY_PENALTY_FIELD_NUMBER: _ClassVar[int]
    PRESENCE_PENALTY_FIELD_NUMBER: _ClassVar[int]
    STOP_SEQUENCES_FIELD_NUMBER: _ClassVar[int]
    USER_FIELD_NUMBER: _ClassVar[int]
    RESPONSE_FORMAT_FIELD_NUMBER: _ClassVar[int]
    STREAM_FIELD_NUMBER: _ClassVar[int]
    prompt: str
    max_tokens: int
    min_tokens: int
    temperature: float
    top_p: float
    top_k: int
    min_p: float
    seed: int
    repetition_penalty: float
    frequency_penalty: float
    presence_penalty: float
    stop_sequences: _containers.RepeatedScalarFieldContainer[str]
    user: str
    response_format: ResponseFormat
    stream: bool
    def __init__(self, prompt: _Optional[str] = ..., max_tokens: _Optional[int] = ..., min_tokens: _Optional[int] = ..., temperature: _Optional[float] = ..., top_p: _Optional[float] = ..., top_k: _Optional[int] = ..., min_p: _Optional[float] = ..., seed: _Optional[int] = ..., repetition_penalty: _Optional[float] = ..., frequency_penalty: _Optional[float] = ..., presence_penalty: _Optional[float] = ..., stop_sequences: _Optional[_Iterable[str]] = ..., user: _Optional[str] = ..., response_format: _Optional[_Union[ResponseFormat, _Mapping]] = ..., stream: bool = ...) -> None: ...

class TokenUsage(_message.Message):
    __slots__ = ("prompt_tokens", "completion_tokens", "total_tokens")
    PROMPT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    COMPLETION_TOKENS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TOKENS_FIELD_NUMBER: _ClassVar[int]
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    def __init__(self, prompt_tokens: _Optional[int] = ..., completion_tokens: _Optional[int] = ..., total_tokens: _Optional[int] = ...) -> None: ...

class TextStreamChunk(_message.Message):
    __slots__ = ("text", "done")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    DONE_FIELD_NUMBER: _ClassVar[int]
    text: str
    done: bool
    def __init__(self, text: _Optional[str] = ..., done: bool = ...) -> None: ...

class GenerateTextOptions(_message.Message):
    __slots__ = ("include_character", "model_type", "max_tokens", "temperature", "frequency_penalty", "presence_penalty", "stop_sequences")
    INCLUDE_CHARACTER_FIELD_NUMBER: _ClassVar[int]
    MODEL_TYPE_FIELD_NUMBER: _ClassVar[int]
    MAX_TOKENS_FIELD_NUMBER: _ClassVar[int]
    TEMPERATURE_FIELD_NUMBER: _ClassVar[int]
    FREQUENCY_PENALTY_FIELD_NUMBER: _ClassVar[int]
    PRESENCE_PENALTY_FIELD_NUMBER: _ClassVar[int]
    STOP_SEQUENCES_FIELD_NUMBER: _ClassVar[int]
    include_character: bool
    model_type: ModelType
    max_tokens: int
    temperature: float
    frequency_penalty: float
    presence_penalty: float
    stop_sequences: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, include_character: bool = ..., model_type: _Optional[_Union[ModelType, str]] = ..., max_tokens: _Optional[int] = ..., temperature: _Optional[float] = ..., frequency_penalty: _Optional[float] = ..., presence_penalty: _Optional[float] = ..., stop_sequences: _Optional[_Iterable[str]] = ...) -> None: ...

class GenerateTextResult(_message.Message):
    __slots__ = ("text", "usage")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    USAGE_FIELD_NUMBER: _ClassVar[int]
    text: str
    usage: TokenUsage
    def __init__(self, text: _Optional[str] = ..., usage: _Optional[_Union[TokenUsage, _Mapping]] = ...) -> None: ...

class TokenizeTextParams(_message.Message):
    __slots__ = ("prompt", "model_type")
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    MODEL_TYPE_FIELD_NUMBER: _ClassVar[int]
    prompt: str
    model_type: ModelType
    def __init__(self, prompt: _Optional[str] = ..., model_type: _Optional[_Union[ModelType, str]] = ...) -> None: ...

class DetokenizeTextParams(_message.Message):
    __slots__ = ("tokens", "model_type")
    TOKENS_FIELD_NUMBER: _ClassVar[int]
    MODEL_TYPE_FIELD_NUMBER: _ClassVar[int]
    tokens: _containers.RepeatedScalarFieldContainer[int]
    model_type: ModelType
    def __init__(self, tokens: _Optional[_Iterable[int]] = ..., model_type: _Optional[_Union[ModelType, str]] = ...) -> None: ...

class TextEmbeddingParams(_message.Message):
    __slots__ = ("text",)
    TEXT_FIELD_NUMBER: _ClassVar[int]
    text: str
    def __init__(self, text: _Optional[str] = ...) -> None: ...

class ImageGenerationParams(_message.Message):
    __slots__ = ("prompt", "size", "count")
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    SIZE_FIELD_NUMBER: _ClassVar[int]
    COUNT_FIELD_NUMBER: _ClassVar[int]
    prompt: str
    size: str
    count: int
    def __init__(self, prompt: _Optional[str] = ..., size: _Optional[str] = ..., count: _Optional[int] = ...) -> None: ...

class ImageDescriptionParams(_message.Message):
    __slots__ = ("image_url", "prompt")
    IMAGE_URL_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    image_url: str
    prompt: str
    def __init__(self, image_url: _Optional[str] = ..., prompt: _Optional[str] = ...) -> None: ...

class ImageDescriptionResult(_message.Message):
    __slots__ = ("title", "description")
    TITLE_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    title: str
    description: str
    def __init__(self, title: _Optional[str] = ..., description: _Optional[str] = ...) -> None: ...

class TranscriptionParams(_message.Message):
    __slots__ = ("audio_url", "prompt")
    AUDIO_URL_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    audio_url: str
    prompt: str
    def __init__(self, audio_url: _Optional[str] = ..., prompt: _Optional[str] = ...) -> None: ...

class TextToSpeechParams(_message.Message):
    __slots__ = ("text", "voice", "speed")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    VOICE_FIELD_NUMBER: _ClassVar[int]
    SPEED_FIELD_NUMBER: _ClassVar[int]
    text: str
    voice: str
    speed: float
    def __init__(self, text: _Optional[str] = ..., voice: _Optional[str] = ..., speed: _Optional[float] = ...) -> None: ...

class AudioProcessingParams(_message.Message):
    __slots__ = ("audio_url", "processing_type")
    AUDIO_URL_FIELD_NUMBER: _ClassVar[int]
    PROCESSING_TYPE_FIELD_NUMBER: _ClassVar[int]
    audio_url: str
    processing_type: str
    def __init__(self, audio_url: _Optional[str] = ..., processing_type: _Optional[str] = ...) -> None: ...

class VideoProcessingParams(_message.Message):
    __slots__ = ("video_url", "processing_type")
    VIDEO_URL_FIELD_NUMBER: _ClassVar[int]
    PROCESSING_TYPE_FIELD_NUMBER: _ClassVar[int]
    video_url: str
    processing_type: str
    def __init__(self, video_url: _Optional[str] = ..., processing_type: _Optional[str] = ...) -> None: ...

class JSONSchema(_message.Message):
    __slots__ = ("type", "properties", "required", "items", "extra")
    class PropertiesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: JSONSchema
        def __init__(self, key: _Optional[str] = ..., value: _Optional[_Union[JSONSchema, _Mapping]] = ...) -> None: ...
    TYPE_FIELD_NUMBER: _ClassVar[int]
    PROPERTIES_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_FIELD_NUMBER: _ClassVar[int]
    ITEMS_FIELD_NUMBER: _ClassVar[int]
    EXTRA_FIELD_NUMBER: _ClassVar[int]
    type: str
    properties: _containers.MessageMap[str, JSONSchema]
    required: _containers.RepeatedScalarFieldContainer[str]
    items: JSONSchema
    extra: _struct_pb2.Struct
    def __init__(self, type: _Optional[str] = ..., properties: _Optional[_Mapping[str, JSONSchema]] = ..., required: _Optional[_Iterable[str]] = ..., items: _Optional[_Union[JSONSchema, _Mapping]] = ..., extra: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class ObjectGenerationParams(_message.Message):
    __slots__ = ("prompt", "schema", "output", "enum_values", "model_type", "temperature", "max_tokens", "stop_sequences")
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    SCHEMA_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_FIELD_NUMBER: _ClassVar[int]
    ENUM_VALUES_FIELD_NUMBER: _ClassVar[int]
    MODEL_TYPE_FIELD_NUMBER: _ClassVar[int]
    TEMPERATURE_FIELD_NUMBER: _ClassVar[int]
    MAX_TOKENS_FIELD_NUMBER: _ClassVar[int]
    STOP_SEQUENCES_FIELD_NUMBER: _ClassVar[int]
    prompt: str
    schema: JSONSchema
    output: str
    enum_values: _containers.RepeatedScalarFieldContainer[str]
    model_type: ModelType
    temperature: float
    max_tokens: int
    stop_sequences: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, prompt: _Optional[str] = ..., schema: _Optional[_Union[JSONSchema, _Mapping]] = ..., output: _Optional[str] = ..., enum_values: _Optional[_Iterable[str]] = ..., model_type: _Optional[_Union[ModelType, str]] = ..., temperature: _Optional[float] = ..., max_tokens: _Optional[int] = ..., stop_sequences: _Optional[_Iterable[str]] = ...) -> None: ...

class ImageGenerationResult(_message.Message):
    __slots__ = ("url",)
    URL_FIELD_NUMBER: _ClassVar[int]
    url: str
    def __init__(self, url: _Optional[str] = ...) -> None: ...

class ModelHandlerInfo(_message.Message):
    __slots__ = ("provider", "priority", "registration_order")
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    PRIORITY_FIELD_NUMBER: _ClassVar[int]
    REGISTRATION_ORDER_FIELD_NUMBER: _ClassVar[int]
    provider: str
    priority: int
    registration_order: int
    def __init__(self, provider: _Optional[str] = ..., priority: _Optional[int] = ..., registration_order: _Optional[int] = ...) -> None: ...
