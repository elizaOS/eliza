import json

from bfcl_eval.constants.type_mappings import GORILLA_TO_OPENAPI
from bfcl_eval.model_handler.local_inference.base_oss_handler import OSSHandler
from bfcl_eval.constants.enums import ModelStyle
from bfcl_eval.model_handler.utils import convert_to_function_call, convert_to_tool
from overrides import override


class GLMHandler(OSSHandler):
    def __init__(
        self,
        model_name,
        temperature,
        registry_name,
        is_fc_model,
        dtype="bfloat16",
        **kwargs,
    ) -> None:
        super().__init__(model_name, temperature, registry_name, is_fc_model, **kwargs)
        self.stop_token_ids = [151329, 151336, 151338]

    @override
    def _format_prompt(self, messages, function):
        """
        "chat_template": "[gMASK]<sop>{% for item in messages %}{% if item['tools'] is defined %}<|system|>\n你是一个名为 ChatGLM 的人工智能助手。你是基于智谱AI训练的语言模型 GLM-4 模型开发的，你的任务是针对用户的问题和要求提供适当的答复和支持。\n\n# 可用工具{% set tools = item['tools'] %}{% for tool in tools %}{% if tool['type'] == 'function' %}\n\n## {{ tool['function']['name'] }}\n\n{{ tool['function'] | tojson(indent=4) }}\n在调用上述函数时，请使用 Json 格式表示调用的参数。{% elif tool['type'] == 'python' %}\n\n## python\n\n当你向 `python` 发送包含 Python 代码的消息时，该代码将会在一个有状态的 Jupyter notebook 环境中执行。\n`python` 返回代码执行的输出，或在执行 60 秒后返回超时。\n`/mnt/data` 将会持久化存储你的文件。在此会话中，`python` 无法访问互联网。不要使用 `python` 进行任何网络请求或者在线 API 调用，这些在线内容的访问将不会成功。{% elif tool['type'] == 'simple_browser' %}\n\n## simple_browser\n\n你可以使用 `simple_browser` 工具。该工具支持以下函数：\n`search(query: str, recency_days: int)`：使用搜索引擎进行查询并显示结果，可以使用 `recency_days` 参数控制搜索内容的时效性。\n`mclick(ids: list[int])`：获取一系列指定 id 的页面内容。每次调用时，须选择3-10个页面。选择多个角度的页面，同时尽可能选择可信任的信息来源。考虑到部分页面是无法加载的，你也可以多打开一些可能有用的页面而不用担心内容过多。\n`open_url(url: str)`：打开指定的 URL。\n\n使用 `【{引用 id}†{引用文本}】` 来引用内容。\n\n操作步骤：1. 使用 `search` 来获得信息列表; 2. 使用 `mclick` 来获取指定 ID 页面的内容; 3. 根据获得的内容进行回复。在回复中应当引用信息来源。\n 如果用户提供了 URL，也可以用 `open_url` 直接打开页面。\n如果初次搜索结果没有找到合适的信息，也可以再次使用 `search` 进行搜索。{% elif tool['type'] == 'cogview' %}\n\n## cogview\n\n如果用户的请求中包含了对图像的描述，你可以使用 `cogview` 来生成图像并展示给用户。你需要向 `cogview` 发送图像描述，规则：\n- 发送给 `cogview` 的消息必须使用英语。用户的中文描述必须完全翻译为英语。\n- 应当尽可能详细地描述图像生成的需求，需求描述约 100 英文单词。\n- 保持用户原始描述的意图。不要虚构内容或者没见过的人物。\n- 如无特殊说明，所在地为中国，持有中国立场并遵循中国社会主义价值观。{% endif %}{% endfor %}{% endif %}{% if item['content'] %}<|{{ item['role'] }}|>{{ item['metadata'] }}\n{{ item['content'] }}{% endif %}{% endfor %}{% if add_generation_prompt %}<|assistant|>{% endif %}",
        """
        formatted_prompt = ""
        tools = convert_to_tool(function, GORILLA_TO_OPENAPI, ModelStyle.OPENAI_COMPLETIONS)
        if tools:
            formatted_prompt = "[gMASK]<sop><|system|>\n你是一个名为 ChatGLM 的人工智能助手。你是基于智谱AI训练的语言模型 GLM-4 模型开发的，你的任务是针对用户的问题和要求提供适当的答复和支持。\n\n# 可用工具"
            for tool in tools:
                formatted_prompt += f"\n\n## {tool['function']['name']}\n\n{json.dumps(tool['function'], indent=4)}"
                formatted_prompt += "\n在调用上述函数时，请使用 Json 格式表示调用的参数。"

        for message in messages:
            formatted_prompt += f"<|{message['role']}|>\n{message['content']}"

        formatted_prompt += "<|assistant|>"

        return formatted_prompt

    @override
    def _pre_query_processing_prompting(self, test_entry: dict) -> dict:
        functions: list = test_entry["function"]

        # GLM use its own system prompt
        return {"message": [], "function": functions}

    @override
    def decode_ast(self, result, language, has_tool_call_tag):
        args = result.split("\n")
        if len(args) == 1:
            func = [args[0]]
        elif len(args) >= 2:
            func = [{args[0]: json.loads(args[1])}]
        return func

    @override
    def decode_execute(self, result, has_tool_call_tag):
        args = result.split("\n")
        if len(args) == 1:
            func = args[0]
        elif len(args) >= 2:
            func = [{args[0]: args[1]}]

        return convert_to_function_call(func)
