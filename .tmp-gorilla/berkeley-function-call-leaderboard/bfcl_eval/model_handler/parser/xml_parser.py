import ast
import xml.etree.ElementTree as ET


def convert_value_by_type(raw_value, type_str):
    if type_str == "string":
        return raw_value
    elif type_str == "integer":
        return int(raw_value)
    elif type_str == "float":
        return float(raw_value)
    elif type_str == "boolean":
        return raw_value.lower() == "true"
    elif type_str == "null":
        return None
    elif (
        type_str == "array"
        or type_str == "tuple"
        or type_str == "object"
        or type_str == "dict"
    ):
        return ast.literal_eval(raw_value)
    else:
        return raw_value  # fallback to raw string


def parse_verbose_xml_function_call(input_str):
    root = ET.fromstring(input_str)
    results = []

    for func in root.findall("function"):
        func_name = func.attrib["name"]
        param_dict = {}

        params_container = func.find("params")
        param_elements = (
            params_container.findall("param")
            if params_container is not None
            else func.findall("param")
        )

        for param in param_elements:
            name = param.attrib.get("name")
            raw_value = param.attrib.get("value", "")
            type_str = param.attrib.get("type", "string")
            parsed_value = convert_value_by_type(raw_value, type_str)
            param_dict[name] = parsed_value

        results.append({func_name: param_dict})

    return results


def parse_concise_xml_function_call(input_str):
    root = ET.fromstring(input_str)
    results = []

    for func in root.findall("function"):
        func_name = func.attrib["name"]
        param_dict = {}

        for param in func.findall("param"):
            name = param.attrib["name"]
            raw_value = param.text or ""
            type_str = param.attrib.get("type", "string")
            parsed_value = convert_value_by_type(raw_value.strip(), type_str)
            param_dict[name] = parsed_value

        results.append({func_name: param_dict})

    return results
