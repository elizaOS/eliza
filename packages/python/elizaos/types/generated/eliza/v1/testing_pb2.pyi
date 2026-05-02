from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class TestCase(_message.Message):
    __slots__ = ("name", "handler_id")
    NAME_FIELD_NUMBER: _ClassVar[int]
    HANDLER_ID_FIELD_NUMBER: _ClassVar[int]
    name: str
    handler_id: str
    def __init__(self, name: _Optional[str] = ..., handler_id: _Optional[str] = ...) -> None: ...

class TestSuite(_message.Message):
    __slots__ = ("name", "tests")
    NAME_FIELD_NUMBER: _ClassVar[int]
    TESTS_FIELD_NUMBER: _ClassVar[int]
    name: str
    tests: _containers.RepeatedCompositeFieldContainer[TestCase]
    def __init__(self, name: _Optional[str] = ..., tests: _Optional[_Iterable[_Union[TestCase, _Mapping]]] = ...) -> None: ...
