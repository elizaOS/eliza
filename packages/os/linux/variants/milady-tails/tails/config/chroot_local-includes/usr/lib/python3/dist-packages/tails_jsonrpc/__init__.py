import json
from enum import IntEnum

# This library is only used internally in Tails, so while we're using a standard protocol, we don't really aim
# for an exact implementation of the standard.
# We still consider https://www.jsonrpc.org/specification (ie: version 2.0) to be our guide, and we document
# whenever we intentionally deviate from the standard:
#  - Batch requests are unsupported.
#  - Notification requests are unsupported (ie: all messages need to have an id)
#  - Requests parameters can only be lists; this is contrary to the specification, which says that they can also
#    be dicts

JSON_RPC_VERSION = "2.0"


class JsonRpcException(Exception):
    pass


class InvalidMessageError(JsonRpcException):
    pass


class FieldNotAllowed(InvalidMessageError):
    pass


class FieldMissing(InvalidMessageError):
    pass


class ResultAndError(InvalidMessageError):
    pass


class Message:
    REQUIRED_FIELDS = frozenset({"jsonrpc", "id"})
    EXTRA_FIELDS = frozenset()

    def _to_dict(self) -> dict:
        raise NotImplementedError()

    @classmethod
    def validate(self, data: dict):
        for k in data:
            if k not in (self.REQUIRED_FIELDS | self.EXTRA_FIELDS):
                raise FieldNotAllowed(k)

        for k in self.REQUIRED_FIELDS:
            if k not in data:
                raise FieldMissing(k)

    def serialize(self) -> str:
        return json.dumps(self._to_dict())


class Response(Message):
    EXTRA_FIELDS = frozenset({"result", "error"})

    def __init__(self):
        pass

    @classmethod
    def validate(self, data: dict):
        super().validate(data)
        if data["jsonrpc"] != JSON_RPC_VERSION:
            raise InvalidMessageError()

        if ("error" in data) == ("result" in data):
            raise ResultAndError


class SuccessResponse(Response):
    def __init__(self, unique_id: int, result):
        super().__init__()
        self.unique_id = unique_id
        self.result = result

    def _to_dict(self) -> dict:
        return {
            "jsonrpc": JSON_RPC_VERSION,
            "id": self.unique_id,
            "result": self.result,
        }


class ErrorType(IntEnum):
    GENERIC = 1


class ErrorResponse(Response):
    def __init__(
        self, unique_id, error, code: ErrorType | int = ErrorType.GENERIC, data=None
    ):
        super().__init__()
        self.unique_id = unique_id
        self.error = error
        self.code = code
        self.data = data

    def _to_dict(self) -> dict:
        return {
            "jsonrpc": JSON_RPC_VERSION,
            "id": self.unique_id,
            "error": {
                "message": str(self.error),
                "code": int(self.code),
                "data": self.data,
            },
        }


class Request(Message):
    REQUIRED_FIELDS = frozenset({"jsonrpc", "id", "method"})
    EXTRA_FIELDS = frozenset({"params"})

    def __init__(
        self,
        unique_id: int,
        method: str,
        args: list[str] | None = None,
    ):
        self.unique_id = unique_id
        self.method = method
        self.args = args if args is not None else []

    @classmethod
    def validate(self, data: dict):
        super().validate(data)

        if "method" not in data:
            raise FieldMissing("method")

        if not isinstance(data.get("params", []), list):
            raise InvalidMessageError("params")

        if not isinstance(data["method"], str):
            raise InvalidMessageError()

    def error_respond(
        self, error: Exception | str, code=None, data=None
    ) -> ErrorResponse:
        kwargs = {}
        if code is not None:
            kwargs["code"] = code
        if data is not None:
            kwargs["data"] = data
        return ErrorResponse(unique_id=self.unique_id, error=error, **kwargs)

    def respond(self, result) -> SuccessResponse:
        return SuccessResponse(
            unique_id=self.unique_id,
            result=result,
        )

    def _to_dict(self):
        jdata = {
            "jsonrpc": JSON_RPC_VERSION,
            "method": self.method,
        }
        if self.args:
            jdata["params"] = self.args
        if self.unique_id is not None:
            jdata["id"] = self.unique_id
        return jdata


class Protocol:
    def __init__(self):
        """
        >>> p = Protocol()
        >>> rq1 = p.create_request('dosth', [42])
        >>> rq = p.parse_request(rq1.serialize())
        >>> rq.method
        'dosth'
        >>> rq.args[0]
        42
        >>> rp1 = rq.error_respond('Something went wrong', code=42, data={'returncode': 5})
        >>> rp = p.parse_reply(rp1.serialize())
        >>> rp.error
        'Something went wrong'
        >>> rp.data["returncode"]
        5
        >>> rp1 = rq.respond({'text': 'all good', 'num': 42})
        >>> rp = p.parse_reply(rp1.serialize())
        >>> rp.result['text']
        'all good'
        >>> rp.result['num']
        42
        """
        self.last_request_id = 0

    def _get_unique_id(self):
        self.last_request_id += 1
        return self.last_request_id

    def create_request(self, method, args=None):
        return Request(unique_id=self._get_unique_id(), method=method, args=args)

    def parse_reply(self, raw: str) -> Response:
        try:
            data = json.loads(raw)
        except json.decoder.JSONDecodeError as e:
            raise InvalidMessageError() from e

        if not isinstance(data, dict):
            raise InvalidMessageError()

        Response.validate(data)

        if "error" in data:
            resp = ErrorResponse(
                unique_id=data["id"],
                error=data["error"]["message"],
                code=data["error"]["code"],
                data=data["error"].get("data", None),
            )
        else:
            resp = SuccessResponse(unique_id=data["id"], result=data["result"])

        return resp

    def parse_request(self, raw: str) -> Request:
        try:
            data = json.loads(raw)
        except json.decoder.JSONDecodeError as e:
            raise InvalidMessageError() from e

        Request.validate(data)

        return Request(
            unique_id=data.get("id", None),
            method=data["method"],
            args=data.get("params", None),
        )
