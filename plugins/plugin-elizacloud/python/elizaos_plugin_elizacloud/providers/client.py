import httpx

from elizaos_plugin_elizacloud.types import (
    ElizaCloudConfig,
    ImageDescriptionParams,
    ImageDescriptionResult,
    ImageGenerationParams,
    TextEmbeddingParams,
    TextGenerationParams,
    TextToSpeechParams,
    TranscriptionParams,
)

SIZE_TO_ASPECT_RATIO: dict[str, str] = {
    "1024x1024": "1:1",
    "1792x1024": "16:9",
    "1024x1792": "9:16",
}


class ElizaCloudClient:
    def __init__(self, config: ElizaCloudConfig) -> None:
        self.config = config
        self._client = httpx.AsyncClient(
            base_url=config.base_url,
            headers={
                "Authorization": f"Bearer {config.api_key}",
                "Content-Type": "application/json",
            },
            timeout=60.0,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "ElizaCloudClient":
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    async def generate_text(
        self,
        params: TextGenerationParams,
        model_size: str = "small",
    ) -> str:
        model = self.config.small_model if model_size == "small" else self.config.large_model

        response = await self._client.post(
            "/chat/completions",
            json={
                "model": model,
                "messages": [{"role": "user", "content": params.prompt}],
                "temperature": params.temperature,
                "max_tokens": params.max_tokens,
                "frequency_penalty": params.frequency_penalty,
                "presence_penalty": params.presence_penalty,
                "stop": params.stop_sequences if params.stop_sequences else None,
                "stream": False,
            },
        )
        response.raise_for_status()
        data = response.json()

        return str(data["choices"][0]["message"]["content"])

    async def generate_embedding(
        self,
        params: TextEmbeddingParams,
    ) -> list[float] | list[list[float]]:
        embedding_url = self.config.embedding_url or self.config.base_url
        embedding_key = self.config.embedding_api_key or self.config.api_key

        if params.texts:
            input_texts = params.texts
        elif params.text:
            input_texts = [params.text]
        else:
            raise ValueError("Either text or texts must be provided")

        async with httpx.AsyncClient(
            base_url=embedding_url,
            headers={
                "Authorization": f"Bearer {embedding_key}",
                "Content-Type": "application/json",
            },
            timeout=60.0,
        ) as client:
            response = await client.post(
                "/embeddings",
                json={
                    "model": self.config.embedding_model,
                    "input": input_texts,
                },
            )
            response.raise_for_status()
            data = response.json()

        embeddings = [item["embedding"] for item in data["data"]]

        if params.text and not params.texts:
            return embeddings[0]
        return embeddings

    async def generate_image(
        self,
        params: ImageGenerationParams,
    ) -> list[dict[str, str]]:
        aspect_ratio = SIZE_TO_ASPECT_RATIO.get(params.size, "1:1")

        response = await self._client.post(
            "/generate-image",
            json={
                "prompt": params.prompt,
                "numImages": params.count,
                "aspectRatio": aspect_ratio,
                "model": self.config.image_generation_model,
            },
        )
        response.raise_for_status()
        data = response.json()

        images = data.get("images", [])
        return [{"url": img.get("url") or img.get("image", "")} for img in images]

    async def describe_image(
        self,
        params: ImageDescriptionParams | str,
    ) -> ImageDescriptionResult:
        if isinstance(params, str):
            image_url = params
            prompt_text = "Please analyze this image and provide a title and detailed description."
        else:
            image_url = params.image_url
            prompt_text = (
                params.prompt
                or "Please analyze this image and provide a title and detailed description."
            )

        response = await self._client.post(
            "/chat/completions",
            json={
                "model": self.config.image_description_model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt_text},
                            {"type": "image_url", "image_url": {"url": image_url}},
                        ],
                    }
                ],
                "max_tokens": self.config.image_description_max_tokens,
            },
        )
        response.raise_for_status()
        data = response.json()

        content = data["choices"][0]["message"]["content"]

        lines = content.strip().split("\n", 1)
        title = lines[0].replace("Title:", "").strip() if lines else "Untitled"
        description = lines[1].strip() if len(lines) > 1 else content

        return ImageDescriptionResult(title=title, description=description)

    async def generate_speech(
        self,
        params: TextToSpeechParams,
    ) -> bytes:
        model = params.model or self.config.tts_model
        voice = params.voice or self.config.tts_voice
        instructions = params.instructions or self.config.tts_instructions

        request_body: dict[str, str | None] = {
            "model": model,
            "input": params.text,
            "voice": voice,
            "format": params.format,
        }
        if instructions:
            request_body["instructions"] = instructions

        response = await self._client.post("/audio/speech", json=request_body)
        response.raise_for_status()

        return response.content

    async def transcribe_audio(
        self,
        params: TranscriptionParams,
    ) -> str:
        model = params.model or self.config.transcription_model

        files = {
            "file": ("audio.wav", params.audio, params.mime_type),
        }
        data: dict[str, str] = {
            "model": model,
            "response_format": params.response_format,
        }
        if params.language:
            data["language"] = params.language
        if params.prompt:
            data["prompt"] = params.prompt
        if params.temperature is not None:
            data["temperature"] = str(params.temperature)

        async with httpx.AsyncClient(
            base_url=self.config.base_url,
            headers={"Authorization": f"Bearer {self.config.api_key}"},
            timeout=120.0,
        ) as client:
            response = await client.post(
                "/audio/transcriptions",
                files=files,
                data=data,
            )
            response.raise_for_status()

        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            result = response.json()
            return str(result.get("text", ""))
        return response.text
