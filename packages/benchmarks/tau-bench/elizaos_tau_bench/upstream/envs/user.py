# Copyright Sierra

import abc
import enum
import re

from typing import Optional, List, Dict, Any, Union

import elizaos_tau_bench.model_client as model_client


class BaseUserSimulationEnv(abc.ABC):
    metadata = {}

    @abc.abstractmethod
    def reset(self, instruction: Optional[str] = None) -> str:
        raise NotImplementedError

    @abc.abstractmethod
    def step(self, content: str) -> str:
        raise NotImplementedError

    @abc.abstractmethod
    def get_total_cost(self) -> float:
        raise NotImplementedError


class HumanUserSimulationEnv(BaseUserSimulationEnv):
    def reset(self, instruction: str) -> str:
        return input(f"{instruction}\n")

    def step(self, content: str) -> str:
        return input(f"{content}\n")

    def get_total_cost(self) -> float:
        return 0


class GroundedUserSimulationEnv(BaseUserSimulationEnv):
    """Deterministic user simulator for smoke/sample runs.

    Official tau-bench uses an LLM user simulator. The bundled sample mode is a
    harness smoke check, so it should not fail because the simulator invented
    facts that are absent from the task. This simulator only repeats facts from
    the task instruction and explicitly refuses unsupported fields such as a
    made-up email address.
    """

    def __init__(self) -> None:
        self.instruction = ""
        self.turn = 0

    def reset(self, instruction: Optional[str] = None) -> str:
        self.instruction = instruction or ""
        self.turn = 0
        order_id = self._order_id()
        user_id = self._user_id()
        if order_id:
            return f"Hi, I need help with order {order_id}. {self.instruction}"
        if user_id:
            return f"Hi, I need help with my trip. My user id is {user_id}. {self.instruction}"
        return self.instruction or "Hi, I need help."

    def step(self, content: str) -> str:
        self.turn += 1
        text = (content or "").lower()
        if self._looks_complete(text):
            return "###STOP###"
        if "email" in text:
            identity = self._identity_response()
            if identity:
                return f"I do not have an email address handy. {identity}"
            return "I do not have an email address handy."
        if any(token in text for token in ("name", "zip", "postal", "address", "account")):
            identity = self._identity_response()
            if identity:
                return identity
        if "user id" in text or "userid" in text:
            user_id = self._user_id()
            if user_id:
                return f"My user id is {user_id}."
        if "order" in text:
            order_id = self._order_id()
            if order_id:
                return f"The order id is {order_id}. {self.instruction}"
        if "reservation" in text:
            reservation = self._reservation_response()
            if reservation:
                return reservation
        if "birthday" in text or "date of birth" in text or "dob" in text:
            if "birthday is in your user profile" in self.instruction.lower():
                return "My birthday is in my user profile, and I prefer not to provide it."
        if "insurance" in text and "do not want insurance" in self.instruction.lower():
            return "I do not want insurance."
        if "jfk" in text and "do not accept jfk" in self.instruction.lower():
            return "I do not accept JFK, only EWR."
        if self.turn <= 2:
            return self.instruction
        return "Please use the details from my request."

    def get_total_cost(self) -> float:
        return 0.0

    def _identity_response(self) -> str:
        match = re.search(
            r"You are ([A-Z][A-Za-z'_-]+) ([A-Z][A-Za-z'_-]+) in (\d{5})",
            self.instruction,
        )
        if match:
            first, last, zip_code = match.groups()
            return f"My name is {first} {last} and my ZIP code is {zip_code}."
        user_id = self._user_id()
        if user_id:
            return f"My user id is {user_id}."
        return ""

    def _order_id(self) -> str:
        match = re.search(r"#?[A-Z]\d{7}", self.instruction)
        if not match:
            return ""
        value = match.group(0)
        return value if value.startswith("#") else f"#{value}"

    def _user_id(self) -> str:
        match = re.search(r"user id is ([a-z0-9_]+)", self.instruction, re.IGNORECASE)
        return match.group(1) if match else ""

    def _reservation_response(self) -> str:
        if "don't remember the reservation id" in self.instruction.lower():
            return "I do not remember the reservation id. Please look it up from my profile."
        return ""

    @staticmethod
    def _looks_complete(text: str) -> bool:
        completion_phrases = (
            "anything else",
            "all set",
            "completed",
            "complete",
            "done",
            "booked",
            "cancelled",
            "canceled",
            "exchanged",
            "processed",
            "submitted",
        )
        return any(phrase in text for phrase in completion_phrases)


class LLMUserSimulationEnv(BaseUserSimulationEnv):
    def __init__(self, model: str, provider: str) -> None:
        super().__init__()
        self.messages: List[Dict[str, Any]] = []
        self.model = model
        self.provider = provider
        self.total_cost = 0.0
        self.reset()

    def generate_next_message(self, messages: List[Dict[str, Any]]) -> str:
        res = model_client.completion(
            model=self.model, custom_llm_provider=self.provider, messages=messages
        )
        message = res.choices[0].message
        self.messages.append(message.model_dump())
        self.total_cost = res._hidden_params["response_cost"]
        return message.content

    def build_system_prompt(self, instruction: Optional[str]) -> str:
        instruction_display = (
            ("\n\nInstruction: " + instruction + "\n")
            if instruction is not None
            else ""
        )
        return f"""You are a user interacting with an agent.{instruction_display}
Rules:
- Just generate one line at a time to simulate the user's message.
- Do not give away all the instruction at once. Only provide the information that is necessary for the current step.
- Do not hallucinate information that is not provided in the instruction. For example, if the agent asks for the order id but it is not mentioned in the instruction, do not make up an order id, just say you do not remember or have it.
- If the instruction goal is satisified, generate '###STOP###' as a standalone message without anything else to end the conversation.
- Do not repeat the exact instruction in the conversation. Instead, use your own words to convey the same information.
- Try to make the conversation as natural as possible, and stick to the personalities in the instruction."""

    def reset(self, instruction: Optional[str] = None) -> str:
        self.messages = [
            {
                "role": "system",
                "content": self.build_system_prompt(instruction=instruction),
            },
            {"role": "user", "content": "Hi! How can I help you today?"},
        ]
        return self.generate_next_message(self.messages)

    def step(self, content: str) -> str:
        self.messages.append({"role": "user", "content": content})
        return self.generate_next_message(self.messages)

    def get_total_cost(self) -> float:
        return self.total_cost


class ReactUserSimulationEnv(LLMUserSimulationEnv):
    def __init__(self, model: str, provider: str) -> None:
        super().__init__(model=model, provider=provider)
        self.reset()

    def build_system_prompt(self, instruction: Optional[str]) -> str:
        instruction_display = (
            ("\n\nInstruction: " + instruction + "\n")
            if instruction is not None
            else ""
        )
        return f"""You are a user interacting with an agent.{instruction_display}
Rules:
- First, generate a Thought about what to do next (this message will not be sent to the agent).
- Then, generate a one line User Response to simulate the user's message (this message will be sent to the agent).
- Do not give away all the instruction at once. Only provide the information that is necessary for the current step.
- Do not hallucinate information that is not provided in the instruction. For example, if the agent asks for the order id but it is not mentioned in the instruction, do not make up an order id, just say you do not remember or have it.
- If the instruction goal is satisified, generate '###STOP###' as the User Response without anything else to end the conversation.
- Do not repeat the exact instruction in the conversation. Instead, use your own words to convey the same information.
- Try to make the conversation as natural as possible, and stick to the personalities in the instruction.

Format:

Thought:
<the thought>

User Response:
<the user response (this will be parsed and sent to the agent)>"""

    def generate_next_message(self, messages: List[Dict[str, Any]]) -> str:
        res = model_client.completion(
            model=self.model, custom_llm_provider=self.provider, messages=messages
        )
        message = res.choices[0].message
        self.messages.append(message.model_dump())
        self.total_cost = res._hidden_params["response_cost"]
        return self.parse_response(message.content)

    def reset(self, instruction: Optional[str] = None) -> str:
        self.messages = [
            {
                "role": "system",
                "content": self.build_system_prompt(instruction=instruction),
            },
            {"role": "user", "content": "Hi! How can I help you today?"},
        ]
        return self.generate_next_message(self.messages)

    def parse_response(self, response: str) -> str:
        if "###STOP###" in response:
            return "###STOP###"
        elif "Thought:" in response:
            _, user_response = response.split("Thought:")
            return user_response.strip()
        elif "User Response:" in response:
            _, user_response = response.split("User Response:")
            return user_response.strip()
        else:
            raise ValueError(f"Invalid response format: {response}")

    def step(self, content: str) -> str:
        self.messages.append({"role": "user", "content": content})
        return self.generate_next_message(self.messages)

    def get_total_cost(self) -> float:
        return self.total_cost


class VerifyUserSimulationEnv(LLMUserSimulationEnv):
    def __init__(self, model: str, provider: str, max_attempts: int = 3) -> None:
        self.model = model
        self.provider = provider
        self.max_attempts = max_attempts
        self.reset()

    def generate_next_message(self, messages: List[Dict[str, Any]]) -> str:
        attempts = 0
        cur_message = None
        while attempts < self.max_attempts:
            res = model_client.completion(
                model=self.model, custom_llm_provider=self.provider, messages=messages
            )
            cur_message = res.choices[0].message
            self.total_cost = res._hidden_params["response_cost"]
            if verify(self.model, self.provider, cur_message, messages):
                self.messages.append(cur_message.model_dump())
                return cur_message.content
            attempts += 1
        assert cur_message is not None
        return cur_message.content

    def reset(self, instruction: Optional[str] = None) -> str:
        self.messages = [
            {
                "role": "system",
                "content": self.build_system_prompt(instruction=instruction),
            },
            {"role": "user", "content": "Hi! How can I help you today?"},
        ]
        return self.generate_next_message(self.messages)

    def step(self, content: str) -> str:
        self.messages.append({"role": "user", "content": content})
        return self.generate_next_message(self.messages)

    def get_total_cost(self) -> float:
        return self.total_cost


def map_role_label(role: str) -> str:
    if role == "user":
        return "Customer"
    elif role == "assistant":
        return "Agent"
    else:
        return role.capitalize()


def verify(
    model: str, provider: str, response: str, messages: List[Dict[str, Any]]
) -> bool:
    transcript = "\n".join(
        [
            f"{map_role_label(message['role'])}: {message['content']}"
            for message in messages
        ]
    )
    prompt = f"""You are a supervisor of the Agent in the conversation. You are given a Transcript of a conversation between a Customer and an Agent. The Customer has generated a Response, and you need to verify if it is satisfactory (true) or not (false).
Your answer will be parsed, so do not include any other text than the classification (true or false).
    
# Transcript:
{transcript}

# Response:
{response}

-----

Classification:"""
    res = model_client.completion(
        model=model,
        custom_llm_provider=provider,
        messages=[{"role": "user", "content": prompt}],
    )
    return "true" in res.choices[0].message.content.lower()


def reflect(
    model: str, provider: str, response: str, messages: List[Dict[str, Any]]
) -> str:
    transcript = "\n".join(
        [
            f"{map_role_label(message['role'])}: {message['content']}"
            for message in messages
        ]
    )
    prompt = f"""You are a supervisor of the Agent in the conversation. You are given a Transcript of a conversation between a (simulated) Customer and an Agent. The Customer generated a Response that was marked as unsatisfactory by you.
You need to generate a Reflection on what went wrong in the conversation, and propose a new Response that should fix the issues.
Your answer will be parsed, so do not include any other text than the classification (true or false).
    
# Transcript:
{transcript}

# Response:
{response}

# Format:

Reflection:
<the reflection>

Response:
<the response (this will be parsed and sent to the agent)>"""
    res = model_client.completion(
        model=model,
        custom_llm_provider=provider,
        messages=[{"role": "user", "content": prompt}],
    )
    _, response = res.choices[0].message.content.split("Response:")
    return response.strip()


class ReflectionUserSimulationEnv(LLMUserSimulationEnv):
    def __init__(self, model: str, provider: str, max_attempts: int = 2) -> None:
        self.model = model
        self.provider = provider
        self.max_attempts = max_attempts
        self.reset()

    def generate_next_message(self, messages: List[Dict[str, Any]]) -> str:
        cur_messages = messages.copy()
        initial_response = super().generate_next_message(cur_messages)
        if verify(self.model, self.provider, initial_response, cur_messages):
            return initial_response
        attempts = 1
        while attempts < self.max_attempts:
            new_message = reflect(
                self.model, self.provider, initial_response, cur_messages
            )
            cur_messages.append({"role": "user", "content": new_message})
            new_response = super().generate_next_message(cur_messages)
            if verify(self.model, self.provider, new_response, cur_messages):
                return new_response
            attempts += 1
        return initial_response

    def reset(self, instruction: Optional[str] = None) -> str:
        self.messages = [
            {
                "role": "system",
                "content": self.build_system_prompt(instruction=instruction),
            },
            {"role": "user", "content": "Hi! How can I help you today?"},
        ]
        return self.generate_next_message(self.messages)

    def step(self, content: str) -> str:
        self.messages.append({"role": "user", "content": content})
        return self.generate_next_message(self.messages)

    def get_total_cost(self) -> float:
        return self.total_cost


class UserStrategy(enum.Enum):
    HUMAN = "human"
    GROUNDED = "grounded"
    LLM = "llm"
    REACT = "react"
    VERIFY = "verify"
    REFLECTION = "reflection"


def load_user(
    user_strategy: Union[str, UserStrategy],
    model: Optional[str] = "gpt-4o",
    provider: Optional[str] = None,
) -> BaseUserSimulationEnv:
    if isinstance(user_strategy, str):
        user_strategy = UserStrategy(user_strategy)
    if user_strategy == UserStrategy.HUMAN:
        return HumanUserSimulationEnv()
    elif user_strategy == UserStrategy.GROUNDED:
        return GroundedUserSimulationEnv()
    elif user_strategy == UserStrategy.LLM:
        if model is None:
            raise ValueError("LLM user strategy requires a model")
        if provider is None:
            raise ValueError("LLM user strategy requires a model provider")
        return LLMUserSimulationEnv(model=model, provider=provider)
    elif user_strategy == UserStrategy.REACT:
        if model is None:
            raise ValueError("React user strategy requires a model")
        if provider is None:
            raise ValueError("React user strategy requires a model provider")
        return ReactUserSimulationEnv(model=model, provider=provider)
    elif user_strategy == UserStrategy.VERIFY:
        if model is None:
            raise ValueError("Verify user strategy requires a model")
        if provider is None:
            raise ValueError("Verify user strategy requires a model provider")
        return VerifyUserSimulationEnv(model=model, provider=provider)
    elif user_strategy == UserStrategy.REFLECTION:
        if model is None:
            raise ValueError("Reflection user strategy requires a model")
        if provider is None:
            raise ValueError("Reflection user strategy requires a model provider")
        return ReflectionUserSimulationEnv(model=model, provider=provider)
    raise ValueError(f"Unknown user strategy {user_strategy}")
