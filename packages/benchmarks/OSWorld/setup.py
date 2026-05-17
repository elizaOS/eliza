import subprocess
import sys

from setuptools import setup, find_packages
from setuptools.command.install import install


class InstallPlaywrightCommand(install):
    """Customized setuptools install command that runs 'playwright install'."""

    def run(self):
        # Call the original install command to handle regular installation process
        install.run(self)

        # Attempt to run 'playwright install' using subprocess
        try:
            subprocess.check_call([sys.executable, "-m", "playwright", "install"])
            print("Successfully ran 'playwright install'.")
        except subprocess.CalledProcessError as e:
            print("Failed to run 'playwright install'. Please run 'playwright install' manually.")
            print(e)


setup(
    name="desktop_env",
    version="1.0.1",
    author="Tianbao Xie, Danyang Zhang,  Jixuan Chen, Xiaochuan Li, Siheng Zhao, Ruisheng Cao, Toh Jing Hua, etc.",
    author_email="tianbaoxiexxx@gmail.com",
    description="The package provides a desktop environment for setting and evaluating desktop automation tasks.",
    long_description=open('README.md', encoding="utf-8").read(),
    long_description_content_type="text/markdown",
    url="https://github.com/xlang-ai/desktop_env",
    packages=find_packages(),
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: Apache Software License",
        "Operating System :: OS Independent",
    ],
    python_requires='>=3.10',
    install_requires=[
        "numpy>=1.26,<3",
        "Pillow~=12.2.0",
        "fabric",
        "gymnasium~=1.3.0",
        "requests~=2.33.0",
        "pytz~=2026.1.post1",
        "transformers~=5.8.0",
        "torch~=2.11.0",
        "accelerate",
        "opencv-python-headless~=4.13.0.92",
        "matplotlib~=3.10.8",
        "pynput~=1.8.1",
        "pyautogui~=0.9.54",
        "psutil~=7.2.2",
        "tqdm~=4.67.3",
        "pandas>=3,<3.1",
        "flask~=3.1.3",
        "requests-toolbelt~=1.0.0",
        "ag2~=0.12.0",
        "lxml",
        "cssselect",
        "xmltodict",
        "openpyxl",
        "python-docx",
        "python-pptx",
        "pypdf",
        "PyGetWindow",
        "rapidfuzz",
        "pyacoustid",
        "pygame",
        "opencv-python-headless",
        "ImageHash",
        "scikit-image",
        "librosa",
        "pymupdf",
        "chardet",
        "playwright",
        "backoff",
        "formulas",
        "pydrive",
        "fastdtw",
        "odfpy",
        "openai",
        "func-timeout",
        "beautifulsoup4",
        "dashscope",
        "google-generativeai",
        "PyYaml",
        "mutagen",
        "easyocr",
        "borb",
        "pypdf2",
        "pdfplumber",
        "wandb",
        "wrapt_timeout_decorator",
        "gdown",
        "tiktoken",
        "groq",
        "boto3",
        "azure-identity",
        "azure-mgmt-compute",
        "azure-mgmt-network",
        "docker",
        "loguru",
        "dotenv",
        "tldextract",
        "anthropic",
        # Aliyun ECS SDK dependencies
        "alibabacloud_ecs20140526",
        "alibabacloud_tea_openapi",
        "alibabacloud_tea_util",
    ],
    cmdclass={
        'install': InstallPlaywrightCommand,  # Use the custom install command
    },
)
