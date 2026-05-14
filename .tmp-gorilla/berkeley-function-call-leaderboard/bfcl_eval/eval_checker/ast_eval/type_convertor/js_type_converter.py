import re
from bfcl_eval.constants.type_mappings import JS_TYPE_CONVERSION


def js_type_converter(value, expected_type, nested_type=None):
    if expected_type not in JS_TYPE_CONVERSION:
        raise ValueError(f"Unsupported type: {expected_type}")

    if expected_type == "String":
        if not (value.startswith('"') and value.endswith('"')) and not (
            value.startswith("'") and value.endswith("'")
        ):
            return str(value)
        return value[1:-1]

    elif expected_type == "integer":
        if not re.match(r"^-?\d+$", value):
            return str(value)  # default to string
        return int(value)
    elif expected_type == "float":
        if not re.match(r"^-?\d+(\.\d+)?$", value):
            return str(value)  # default to string
        return float(value)
    elif expected_type == "Bigint":
        if not re.match(r"^-?\d+n$", value):
            return str(value)  # default to string
        return int(value[:-1])
    elif expected_type == "Boolean":
        if value not in ["true", "false"]:
            return str(value)  # default to string
        return value == "true"
    elif expected_type == "dict":
        return parse_js_collection(value, "dict", nested_type)
    elif expected_type == "array":
        return parse_js_collection(value, "array", nested_type)
    elif expected_type == "any":
        return str(value)
    else:
        raise ValueError(f"Unsupported type: {expected_type}")


def parse_js_collection(code, type_str, nested_type=None):
    code = code.strip()
    if type_str == "array":
        # Regular expression patterns
        array_2d_pattern = r"\[\s*\[.*?\]\s*(,\s*\[.*?\]\s*)*\]|\bnew\s+Array\(\s*\[.*?\]\s*(,\s*\[.*?\]\s*)*\)"
        array_pattern = r"\[(.*?)\]|\bnew\s+Array\((.*?)\)"

        # Check if the code is a 2D array
        array_2d_match = re.match(array_2d_pattern, code)
        try:
            if array_2d_match:
                elements_str = array_2d_match.group(0)
                inner_arrays = re.findall(r"\[(.*?)\]", elements_str)
                elements = []
                for idx, inner_array_str in enumerate(inner_arrays):
                    inner_array_str = inner_array_str.strip()
                    if idx == 0 and inner_array_str.startswith("["):
                        inner_array_str = inner_array_str[1:]
                    inner_array_elements = [
                        e.strip() for e in inner_array_str.split(",")
                    ]
                    if nested_type:
                        inner_array = [parse_js_value(e) for e in inner_array_elements]
                    else:
                        inner_array = [parse_js_value(e) for e in inner_array_elements]
                    elements.append(inner_array)
                return elements

            # Check if the code is a 1D array
            array_match = re.match(array_pattern, code)
            if array_match:
                if array_match.group(1) is not None:
                    elements_str = array_match.group(1).strip()
                    if elements_str:
                        elements = elements_str.split(",")
                    else:
                        elements = []
                elif array_match.group(2) is not None:
                    elements_str = array_match.group(2).strip()
                    if elements_str:
                        elements = elements_str.split(",")
                    else:
                        elements = []
                else:
                    elements = []
                if nested_type:
                    elements = [
                        (
                            js_type_converter(e.strip(), nested_type, "String")
                            if (e.strip().startswith("'") or e.strip().startswith('"'))
                            else js_type_converter(e.strip(), nested_type)
                        )
                        for e in elements
                    ]
                else:
                    elements = [parse_js_value(e.strip()) for e in elements]
                return elements
            else:
                return code
        except:
            return code

    elif type_str == "dict":
        if code == "{}":
            return {}  # Return an empty dictionary for an empty object
        dict_pattern = r"\{(.*?)\}"
        # Check if the code is a dictionary
        dict_match = re.match(dict_pattern, code)
        if dict_match:
            try:
                content = dict_match.group(1)
                pairs = re.findall(r"([^:]+):\s*(.*?)(?:,\s*(?=[^,]+:)|$)", content)
                dictionary = {}
                for key, value in pairs:
                    key = key.strip().strip("'\"")
                    value = value.strip()
                    if value.startswith("[") and value.endswith("]"):
                        # Handle array values
                        dictionary[key] = parse_js_collection(value, "array")
                    elif value.startswith("{") and value.endswith("}"):
                        # Handle nested dictionary values
                        dictionary[key] = parse_js_collection(value, "dict")
                    else:
                        dictionary[key] = parse_js_value(value.strip("'\""))
                return dictionary
            except Exception as e:
                print(f"Error parsing dictionary: {e}")
                return code
        else:
            return code  # default to string
    else:
        raise ValueError(f"Unsupported type: {type_str}")


def parse_js_value(value_str: str):
    value_str = value_str.strip()
    if value_str == "true":
        return True
    elif value_str == "false":
        return False
    elif (value_str.startswith('"') and value_str.endswith('"')) or (
        value_str.startswith("'") and value_str.endswith("'")
    ):
        return value_str[1:-1]
    else:
        try:
            return int(value_str)
        except ValueError:
            try:
                return float(value_str)
            except ValueError:
                return value_str


# Write tests for the `js_type_converter` function
def test_js_type_converter():
    assert js_type_converter("true", "Boolean") == True
    assert js_type_converter("false", "Boolean") == False
    assert js_type_converter("123", "integer") == 123
    assert js_type_converter("3.14", "float") == 3.14
    assert js_type_converter("123n", "Bigint") == 123
    assert js_type_converter("abc", "String") == "abc"
    assert js_type_converter("[1, 2, 3]", "array") == [1, 2, 3]
    assert js_type_converter("new Array(1, 2, 3)", "array") == [1, 2, 3]
    assert js_type_converter("{'key': 'value'}", "dict") == {"key": "value"}
    assert js_type_converter("{'key': 123}", "dict") == {"key": 123}
    assert js_type_converter("{'key': true}", "dict") == {"key": True}

    # Additional test cases
    # Test empty array and dictionary
    assert js_type_converter("[]", "array") == []
    assert js_type_converter("{}", "dict") == {}

    # Test array with mixed types
    assert js_type_converter("[1, 'two', true]", "array") == [1, "two", True]

    # Test dictionary with mixed types
    assert js_type_converter(
        "{'key1': 123, 'key2': 'value', 'key3': false}", "dict"
    ) == {"key1": 123, "key2": "value", "key3": False}

    # Test string with special characters

    # Test negative integer and float values
    assert js_type_converter("-123", "integer") == -123
    assert js_type_converter("-3.14", "float") == -3.14

    # Test invalid type
    try:
        js_type_converter("123", "InvalidType")
    except ValueError as e:
        assert str(e) == "Unsupported type: InvalidType"

    # Test invalid integer value
    try:
        js_type_converter("123.45", "integer")
    except ValueError as e:
        assert str(e) == "Invalid integer value: 123.45"

    # Test invalid float value
    try:
        js_type_converter("3.14abc", "float")
    except ValueError as e:
        assert str(e) == "Invalid float value: 3.14abc"

    # Test invalid Bigint value
    try:
        js_type_converter("123", "Bigint")
    except ValueError as e:
        assert str(e) == "Invalid Bigint value: 123"

    # Test invalid boolean value
    try:
        js_type_converter("not_a_boolean", "Boolean")
    except ValueError as e:
        assert str(e) == "Invalid boolean value: not_a_boolean"

    print("All tests passed successfully!")


def test_js_type_converter_nested_array():
    # Test array with nested integers
    assert js_type_converter("[1, 2, 3]", "array", "integer") == [1, 2, 3]
    assert js_type_converter("new Array(4, 5, 6)", "array", "integer") == [4, 5, 6]

    # Test array with nested floats
    assert js_type_converter("[1.1, 2.2, 3.3]", "array", "float") == [1.1, 2.2, 3.3]
    assert js_type_converter("new Array(4.4, 5.5, 6.6)", "array", "float") == [
        4.4,
        5.5,
        6.6,
    ]

    # Test array with nested Bigints
    assert js_type_converter("[1n, 2n, 3n]", "array", "Bigint") == [1, 2, 3]
    assert js_type_converter("new Array(4n, 5n, 6n)", "array", "Bigint") == [4, 5, 6]

    # Test array with nested booleans
    assert js_type_converter("[true, false, true]", "array", "Boolean") == [
        True,
        False,
        True,
    ]
    assert js_type_converter("new Array(false, true, false)", "array", "Boolean") == [
        False,
        True,
        False,
    ]

    # Test array with nested strings
    print(js_type_converter('["hello", "world", "!"]', "array", "String"))
    assert js_type_converter('["hello", "world", "!"]', "array", "String") == [
        "hello",
        "world",
        "!",
    ]
    assert js_type_converter('new Array("foo", "bar", "baz")', "array", "String") == [
        "foo",
        "bar",
        "baz",
    ]

    # Test array with mixed nested types
    assert js_type_converter('[1, "two", true]', "array") == [1, "two", True]
    assert js_type_converter('new Array(3.14, "pi", false)', "array") == [
        3.14,
        "pi",
        False,
    ]

    # Test array with nested arrays
    print(js_type_converter(" [ [1, 2], [3, 4], [5, 6]]", "array", "array"))
    assert js_type_converter(" [ [ 1, 2 ], [ 3,   4], [5, 6]]", "array", "array") == [
        [1, 2],
        [3, 4],
        [5, 6],
    ]  # this example has many weird spacings
    assert js_type_converter("new Array([1, 2], [3, 4], [5, 6])", "array", "array") == [
        [1, 2],
        [3, 4],
        [5, 6],
    ]

    # Test array with nested dictionaries
    assert js_type_converter(
        '[{"key1": 1}, {"key2": 2}, {"key3": 3}]', "array", "dict"
    ) == [{"key1": 1}, {"key2": 2}, {"key3": 3}]
    assert js_type_converter(
        'new Array({"key1": 1}, {"key2": 2}, {"key3": 3})', "array", "dict"
    ) == [{"key1": 1}, {"key2": 2}, {"key3": 3}]

    print("All nested array tests passed successfully!")


def test_js_type_converter_dictionary_with_arrays():
    complex_dict = js_type_converter(
        '{"initialState": initialStateObject, "reducers": reducersMap, "middlewares": ["loggerMiddleware"], "enhancers": ["applyMiddleware", "myMiddleWare"]}',
        "dict",
    )
    assert isinstance(complex_dict, dict)
    assert complex_dict["initialState"] == "initialStateObject"
    assert complex_dict["reducers"] == "reducersMap"
    assert complex_dict["middlewares"] == ["loggerMiddleware"]
    assert complex_dict["enhancers"] == ["applyMiddleware", "myMiddleWare"]
    print("Complex dictionary test passed successfully!")

if __name__ == "__main__":
    test_js_type_converter()
    test_js_type_converter_nested_array()
    test_js_type_converter_dictionary_with_arrays()
