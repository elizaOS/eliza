from tree_sitter import Language, Parser
import tree_sitter_javascript

JS_LANGUAGE = Language(tree_sitter_javascript.language(), "javascript")

parser = Parser()
parser.set_language(JS_LANGUAGE)


def parse_javascript_function_call(source_code):
    # Parse the source code
    tree = parser.parse(bytes(source_code, "utf8"))
    root_node = tree.root_node
    sexp_result = root_node.sexp()
    if "ERROR" in sexp_result:
        raise SyntaxError("Error js parsing the source code.")

    # Function to recursively extract argument details
    def extract_arguments(node):
        args = {}
        for child in node.children:
            if child.type == "assignment_expression":
                # Extract left (name) and right (value) parts of the assignment
                name = child.children[0].text.decode("utf-8")
                value = child.children[2].text.decode("utf-8")
                if (value.startswith('"') and value.endswith('"')) or (
                    value.startswith("'") and value.endswith("'")
                ):
                    value = value[1:-1]  # Trim the quotation marks
                if name in args:
                    if not isinstance(args[name], list):
                        args[name] = [args[name]]
                    args[name].append(value)
                else:
                    args[name] = value

            elif child.type == "identifier" or child.type == "true":
                # Handle non-named arguments and boolean values
                value = child.text.decode("utf-8")
                if None in args:
                    if not isinstance(args[None], list):
                        args[None] = [args[None]]
                    args[None].append(value)
                else:
                    args[None] = value
        return args

    # Find the function call and extract its name and arguments
    if root_node.type == "program":
        for child in root_node.children:
            if child.type == "expression_statement":
                for sub_child in child.children:
                    if sub_child.type == "call_expression":
                        function_name = sub_child.children[0].text.decode("utf8")
                        arguments_node = sub_child.children[1]
                        parameters = extract_arguments(arguments_node)
                        for key, value in parameters.items():
                            if isinstance(value, list):
                                raise Exception(
                                    "Error: Multiple arguments with the same name are not supported."
                                )
                        result = [{function_name: parameters}]
                        return result
