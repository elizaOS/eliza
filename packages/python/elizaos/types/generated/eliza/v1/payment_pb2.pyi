from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class PaymentConfigDefinition(_message.Message):
    __slots__ = ("network", "asset_namespace", "asset_reference", "payment_address", "symbol", "chain_id")
    NETWORK_FIELD_NUMBER: _ClassVar[int]
    ASSET_NAMESPACE_FIELD_NUMBER: _ClassVar[int]
    ASSET_REFERENCE_FIELD_NUMBER: _ClassVar[int]
    PAYMENT_ADDRESS_FIELD_NUMBER: _ClassVar[int]
    SYMBOL_FIELD_NUMBER: _ClassVar[int]
    CHAIN_ID_FIELD_NUMBER: _ClassVar[int]
    network: str
    asset_namespace: str
    asset_reference: str
    payment_address: str
    symbol: str
    chain_id: str
    def __init__(self, network: _Optional[str] = ..., asset_namespace: _Optional[str] = ..., asset_reference: _Optional[str] = ..., payment_address: _Optional[str] = ..., symbol: _Optional[str] = ..., chain_id: _Optional[str] = ...) -> None: ...

class X402Config(_message.Message):
    __slots__ = ("price_in_cents", "payment_configs")
    PRICE_IN_CENTS_FIELD_NUMBER: _ClassVar[int]
    PAYMENT_CONFIGS_FIELD_NUMBER: _ClassVar[int]
    price_in_cents: int
    payment_configs: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, price_in_cents: _Optional[int] = ..., payment_configs: _Optional[_Iterable[str]] = ...) -> None: ...

class X402Accepts(_message.Message):
    __slots__ = ("scheme", "network", "max_amount_required", "resource", "description", "mime_type", "pay_to", "max_timeout_seconds", "asset", "output_schema", "extra")
    SCHEME_FIELD_NUMBER: _ClassVar[int]
    NETWORK_FIELD_NUMBER: _ClassVar[int]
    MAX_AMOUNT_REQUIRED_FIELD_NUMBER: _ClassVar[int]
    RESOURCE_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    MIME_TYPE_FIELD_NUMBER: _ClassVar[int]
    PAY_TO_FIELD_NUMBER: _ClassVar[int]
    MAX_TIMEOUT_SECONDS_FIELD_NUMBER: _ClassVar[int]
    ASSET_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_SCHEMA_FIELD_NUMBER: _ClassVar[int]
    EXTRA_FIELD_NUMBER: _ClassVar[int]
    scheme: str
    network: str
    max_amount_required: str
    resource: str
    description: str
    mime_type: str
    pay_to: str
    max_timeout_seconds: int
    asset: str
    output_schema: _struct_pb2.Struct
    extra: _struct_pb2.Struct
    def __init__(self, scheme: _Optional[str] = ..., network: _Optional[str] = ..., max_amount_required: _Optional[str] = ..., resource: _Optional[str] = ..., description: _Optional[str] = ..., mime_type: _Optional[str] = ..., pay_to: _Optional[str] = ..., max_timeout_seconds: _Optional[int] = ..., asset: _Optional[str] = ..., output_schema: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., extra: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class X402Response(_message.Message):
    __slots__ = ("x402_version", "error", "accepts", "payer")
    X402_VERSION_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    ACCEPTS_FIELD_NUMBER: _ClassVar[int]
    PAYER_FIELD_NUMBER: _ClassVar[int]
    x402_version: int
    error: str
    accepts: _containers.RepeatedCompositeFieldContainer[X402Accepts]
    payer: str
    def __init__(self, x402_version: _Optional[int] = ..., error: _Optional[str] = ..., accepts: _Optional[_Iterable[_Union[X402Accepts, _Mapping]]] = ..., payer: _Optional[str] = ...) -> None: ...
