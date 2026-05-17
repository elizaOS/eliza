import inspect
import json
import os
import textwrap

current_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def generate_func(json_data):
    # 收集所有类名和它们的函数
    class_funcs = {}
    no_class_funcs = []
    cls_name = ""

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
        cls_name = class_name
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

    return code.strip(), cls_name


setup_prompt = """You are an agent which follow my instruction and perform desktop computer tasks as instructed.
You have good knowledge of computer and good internet connection and assume your code will run on a computer for controlling the mouse and keyboard.
For each step, you will get an observation of the desktop by 1) screenshot; 2) current application name; 3) accessibility tree, which is based on AT-SPI library; 4) application info; 5) last action result.
You should first generate a plan for completing the task, confirm the previous results, reflect on the current status, then generate operations to complete the task in python-style pseudo code using the predefined functions.

Your output should STRICTLY follow the format:
<think>
{**YOUR-PLAN-AND-THINKING**}
</think>
```python
{**ONE-LINE-OF-CODE**}
```"""

func_def_tool_template = """You will be provided access to the following methods to interact with the UI:
    1. class Agent, a grounding agent which provides basic action space to interact with desktop.
    2. class {tool_class_name}, which provides tools to interact with the current application {app_name}.

Here are the defination of the classes:
```python
{class_content}
```"""

func_def_template = """You will be provided access to the following methods to interact with the UI:

```python
{class_content}
```"""

note_prompt = """* Note:
- Your code should be wrapped in ```python```, and your plan and thinking should be wrapped in <think></think>.
- Only **ONE-LINE-OF-CODE** at a time.
- Each code block is context independent, and variables from the previous round cannot be used in the next round.
- Do not put anything other than python code in ```python```.
- You **can only use the above methods to interact with the UI**, do not invent new methods.
- Return with `Agent.exit(success=True)` immediately after the task is completed.
- If you think cannot complete the task, **DO NOT keep repeating actions, just return with `Agent.exit(success=False)`.**
- The computer's environment is Linux, e.g., Desktop path is '/home/user/Desktop'
- My computer's password is '{client_password}', feel free to use it when you need sudo rights"""


class Prompt:
    @staticmethod
    def construct_procedural_memory(agent_class, app_name=None, client_password="password"):
        agent_class_content = "Class Agent:"
        for attr_name in dir(agent_class):
            attr = getattr(agent_class, attr_name)
            if callable(attr) and hasattr(attr, "is_agent_action"):
                # Use inspect to get the full function signature
                signature = inspect.signature(attr)
                agent_class_content += f"""
    def {attr_name}{signature}:
        '''{attr.__doc__}'''
    """

        if app_name is not None:
            tool_path = os.path.join(current_dir, "tools", "apis", f"{app_name.lower()}.json")
            with open(tool_path, "r") as f:
                json_data = json.load(f)

            tool_class_content, tool_class_name = generate_func(json_data)

            agent_class_content += "\n\n{}".format(tool_class_content)
            func_def_prompt = func_def_tool_template.format(
                class_content=agent_class_content.strip(),
                tool_class_name=tool_class_name,
                app_name=app_name,
                client_password=client_password,
            )
        else:
            func_def_prompt = func_def_template.format(class_content=agent_class_content.strip())
        note_prompt_formatted = note_prompt.format(client_password=client_password)

        # procedural_memory = f"{setup_prompt}\n\n{func_def_prompt}\n\n{note_prompt}".strip()
        # return procedural_memory
        return setup_prompt, func_def_prompt, note_prompt_formatted


if __name__ == "__main__":
    from grounding_agent import GroundingAgent

    print(Prompt.construct_procedural_memory(GroundingAgent, "vlc"))
