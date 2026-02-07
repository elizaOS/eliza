"""Tests for MIME utilities."""

from elizaos.media.mime import (
    MediaKind,
    extension_for_mime,
    get_file_extension,
    image_mime_from_format,
    is_audio_filename,
    is_gif_media,
    is_voice_compatible_audio,
    media_kind_from_mime,
)


class TestGetFileExtension:
    def test_simple_path(self):
        assert get_file_extension("test.jpg") == ".jpg"

    def test_path_with_directory(self):
        assert get_file_extension("path/to/file.PNG") == ".png"

    def test_no_extension(self):
        assert get_file_extension("noext") is None

    def test_none_input(self):
        assert get_file_extension(None) is None

    def test_url(self):
        assert get_file_extension("https://example.com/image.webp") == ".webp"


class TestMediaKindFromMime:
    def test_image(self):
        assert media_kind_from_mime("image/jpeg") == MediaKind.IMAGE
        assert media_kind_from_mime("image/png") == MediaKind.IMAGE

    def test_audio(self):
        assert media_kind_from_mime("audio/mp3") == MediaKind.AUDIO
        assert media_kind_from_mime("audio/ogg") == MediaKind.AUDIO

    def test_video(self):
        assert media_kind_from_mime("video/mp4") == MediaKind.VIDEO

    def test_document(self):
        assert media_kind_from_mime("application/pdf") == MediaKind.DOCUMENT
        assert media_kind_from_mime("text/plain") == MediaKind.DOCUMENT

    def test_unknown(self):
        assert media_kind_from_mime("application/octet-stream") == MediaKind.UNKNOWN
        assert media_kind_from_mime(None) == MediaKind.UNKNOWN


class TestIsAudioFilename:
    def test_audio_files(self):
        assert is_audio_filename("song.mp3") is True
        assert is_audio_filename("voice.ogg") is True
        assert is_audio_filename("music.wav") is True

    def test_non_audio_files(self):
        assert is_audio_filename("image.jpg") is False
        assert is_audio_filename("document.pdf") is False

    def test_none(self):
        assert is_audio_filename(None) is False


class TestIsGifMedia:
    def test_gif_content_type(self):
        assert is_gif_media(content_type="image/gif") is True

    def test_gif_filename(self):
        assert is_gif_media(filename="animation.gif") is True

    def test_non_gif(self):
        assert is_gif_media(content_type="image/jpeg") is False
        assert is_gif_media(filename="photo.jpg") is False


class TestIsVoiceCompatibleAudio:
    def test_ogg_content_type(self):
        assert is_voice_compatible_audio(content_type="audio/ogg") is True
        assert is_voice_compatible_audio(content_type="audio/opus") is True

    def test_ogg_filename(self):
        assert is_voice_compatible_audio(filename="voice.ogg") is True
        assert is_voice_compatible_audio(filename="voice.opus") is True

    def test_non_voice_compatible(self):
        assert is_voice_compatible_audio(content_type="audio/mp3") is False
        assert is_voice_compatible_audio(filename="song.mp3") is False


class TestExtensionForMime:
    def test_known_mimes(self):
        assert extension_for_mime("image/jpeg") == ".jpg"
        assert extension_for_mime("audio/mpeg") == ".mp3"
        assert extension_for_mime("video/mp4") == ".mp4"

    def test_none(self):
        assert extension_for_mime(None) is None

    def test_unknown_mime(self):
        assert extension_for_mime("application/x-unknown") is None


class TestImageMimeFromFormat:
    def test_known_formats(self):
        assert image_mime_from_format("jpg") == "image/jpeg"
        assert image_mime_from_format("jpeg") == "image/jpeg"
        assert image_mime_from_format("png") == "image/png"
        assert image_mime_from_format("gif") == "image/gif"

    def test_none(self):
        assert image_mime_from_format(None) is None

    def test_unknown_format(self):
        assert image_mime_from_format("bmp") is None
