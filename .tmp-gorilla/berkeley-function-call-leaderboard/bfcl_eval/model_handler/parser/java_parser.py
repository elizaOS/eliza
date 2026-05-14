from tree_sitter import Language, Parser
import tree_sitter_java

JAVA_LANGUAGE = Language(tree_sitter_java.language(), "java")

parser = Parser()
parser.set_language(JAVA_LANGUAGE)


def parse_java_function_call(source_code):
    tree = parser.parse(bytes(source_code, "utf8"))
    root_node = tree.root_node
    sexp_result = root_node.sexp()

    if "ERROR" in sexp_result:
        raise SyntaxError("Error parsing java the source code.")

    def get_text(node):
        """Returns the text represented by the node."""
        return source_code[node.start_byte : node.end_byte]

    def traverse_node(node, nested=False):
        if node.type == "string_literal":
            if nested:
                return get_text(node)
            # Strip surrounding quotes from string literals
            return get_text(node)[1:-1]
        elif node.type == "character_literal":
            if nested:
                return get_text(node)
            # Strip surrounding single quotes from character literals
            return get_text(node)[1:-1]
        """Traverse the node to collect texts for complex structures."""
        if node.type in [
            "identifier",
            "class_literal",
            "type_identifier",
            "method_invocation",
        ]:
            return get_text(node)
        elif node.type == "array_creation_expression":
            # Handle array creation expression specifically
            type_node = node.child_by_field_name("type")
            value_node = node.child_by_field_name("value")
            type_text = traverse_node(type_node, True)
            value_text = traverse_node(value_node, True)
            return f"new {type_text}[]{value_text}"
        elif node.type == "object_creation_expression":
            # Handle object creation expression specifically
            type_node = node.child_by_field_name("type")
            arguments_node = node.child_by_field_name("arguments")
            type_text = traverse_node(type_node, True)
            if arguments_node:
                # Process each argument carefully, avoiding unnecessary punctuation
                argument_texts = []
                for child in arguments_node.children:
                    if child.type not in [
                        ",",
                        "(",
                        ")",
                    ]:  # Exclude commas and parentheses
                        argument_text = traverse_node(child, True)
                        argument_texts.append(argument_text)
                arguments_text = ", ".join(argument_texts)
                return f"new {type_text}({arguments_text})"
            else:
                return f"new {type_text}()"
        elif node.type == "set":
            # Handling sets specifically
            items = [
                traverse_node(n, True)
                for n in node.children
                if n.type not in [",", "set"]
            ]
            return "{" + ", ".join(items) + "}"

        elif node.child_count > 0:
            return "".join(traverse_node(child, True) for child in node.children)
        else:
            return get_text(node)

    def extract_arguments(args_node):
        arguments = {}
        for child in args_node.children:
            if child.type == "assignment_expression":
                # For named parameters
                name_node, value_node = child.children[0], child.children[2]
                name = get_text(name_node)
                value = traverse_node(value_node)
                if name in arguments:
                    if not isinstance(arguments[name], list):
                        arguments[name] = [arguments[name]]
                    arguments[name].append(value)
                else:
                    arguments[name] = value
                # arguments.append({'name': name, 'value': value})
            elif child.type in ["identifier", "class_literal", "set"]:
                # For unnamed parameters and handling sets
                value = traverse_node(child)
                if None in arguments:
                    if not isinstance(arguments[None], list):
                        arguments[None] = [arguments[None]]
                    arguments[None].append(value)
                else:
                    arguments[None] = value
        return arguments

    def traverse(node):
        if node.type == "method_invocation":
            # Extract the function name and its arguments
            method_name = get_text(node.child_by_field_name("name"))
            class_name_node = node.child_by_field_name("object")
            if class_name_node:
                class_name = get_text(class_name_node)
                function_name = f"{class_name}.{method_name}"
            else:
                function_name = method_name
            arguments_node = node.child_by_field_name("arguments")
            if arguments_node:
                arguments = extract_arguments(arguments_node)
                for key, value in arguments.items():
                    if isinstance(value, list):
                        raise Exception(
                            "Error: Multiple arguments with the same name are not supported."
                        )
                return [{function_name: arguments}]

        else:
            for child in node.children:
                result = traverse(child)
                if result:
                    return result

    result = traverse(root_node)
    return result if result else {}
