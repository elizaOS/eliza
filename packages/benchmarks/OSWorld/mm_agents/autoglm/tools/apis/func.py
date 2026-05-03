def generate_func(json_data):
    # 收集所有类名和它们的函数
    class_funcs = {}
    no_class_funcs = []

    for item in json_data:
        if item["type"] == "function":
            func = item["function"]
            func_parts = func["name"].split(".")

            if len(func_parts) == 2:
                class_name, func_name = func_parts
                if class_name not in class_funcs:
                    class_funcs[class_name] = []
                class_funcs[class_name].append(item)
            else:
                no_class_funcs.append(item)

    code = ""

    # 生成有类的函数
    for class_name, funcs in class_funcs.items():
        code += f"class {class_name}:\n"
        for item in funcs:
            func = item["function"]
            func_name = func["name"].split(".")[-1]
            description = func["description"]
            params = func["parameters"]["properties"]
            required = func["parameters"].get("required", [])

            # 构建参数列表
            param_list = ["cls"]
            # 首先添加必需参数
            for param_name in required:
                param_list.append(f"{param_name}")
            # 然后添加可选参数
            for param_name in params:
                if param_name not in required:
                    param_list.append(f"{param_name}")  # 可选参数默认值设为None

            # 构建函数定义
            func_def = f"    def {func_name}({', '.join(param_list)}):\n"

            # 构建文档字符串
            docstring = f'        """\n        {description}\n\n        Args:\n'
            if len(param_list) == 1:  # 只有cls参数
                docstring += "            None\n"
            else:
                # 首先记录必需参数
                for param_name in required:
                    param_type = params[param_name]["type"]
                    param_desc = params[param_name].get("description", "")
                    docstring += f"            {param_name} ({param_type}): {param_desc}\n"
                # 然后记录可选参数
                for param_name in params:
                    if param_name not in required:
                        param_type = params[param_name]["type"]
                        param_desc = params[param_name].get("description", "")
                        docstring += f"            {param_name} ({param_type}, optional): {param_desc}\n"

            docstring += '        """\n'

            code += func_def + docstring + "\n"

        code += "\n"

    # 生成没有类的函数
    for item in no_class_funcs:
        func = item["function"]
        func_name = func["name"]
        description = func["description"]
        params = func["parameters"]["properties"]
        required = func["parameters"].get("required", [])

        # 构建参数列表
        param_list = []
        # 首先添加必需参数
        for param_name in required:
            param_list.append(f"{param_name}")
        # 然后添加可选参数
        for param_name in params:
            if param_name not in required:
                param_list.append(f"{param_name}")

        # 构建函数定义
        func_def = f"def {func_name}({', '.join(param_list)}):\n"

        # 构建文档字符串
        docstring = f'    """\n    {description}\n\n    Args:\n'
        if not param_list:
            docstring += "        None\n"
        else:
            # 首先记录必需参数
            for param_name in required:
                param_type = params[param_name]["type"]
                param_desc = params[param_name].get("description", "")
                docstring += f"        {param_name} ({param_type}): {param_desc}\n"
            # 然后记录可选参数
            for param_name in params:
                if param_name not in required:
                    param_type = params[param_name]["type"]
                    param_desc = params[param_name].get("description", "")
                    docstring += f"        {param_name} ({param_type}, optional): {param_desc}\n"

        docstring += '    """\n'

        code += func_def + docstring + "\n"

    return code.strip()


if __name__ == "__main__":
    import json

    with open("libreoffice_calc.json", "r") as f:
        json_data = json.load(f)
    print(generate_func(json_data))
