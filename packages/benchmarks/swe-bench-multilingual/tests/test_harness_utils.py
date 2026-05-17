import unittest
from swebench.harness.utils import run_threadpool
from swebench.harness.test_spec.python import clean_environment_yml, clean_requirements


class UtilTests(unittest.TestCase):
    def test_run_threadpool_all_failures(self):
        def failing_func(_):
            raise ValueError("Test error")

        payloads = [(1,), (2,), (3,)]
        succeeded, failed = run_threadpool(failing_func, payloads, max_workers=2)
        self.assertEqual(len(succeeded), 0)
        self.assertEqual(len(failed), 3)

    def test_environment_yml_cleaner(self):
        """
        We want to make sure that our cleaner only modifies the pip section of the environment.yml
        and that it does not modify the other dependencies sections.

        We expect "types-pkg_resources" to be replaced with "types-setuptools" in the pip section.
        """
        env_yaml = (
            "# To set up a development environment using conda run:\n"
            "#\n"
            "#   conda env create -f environment.yml\n"
            "#   conda activate mpl-dev\n"
            '#   pip install --verbose --no-build-isolation --editable ".[dev]"\n'
            "#\n"
            "---\n"
            "name: matplotlib-master\n"
            "channels:\n"
            "  - conda-forge\n"
            "dependencies:\n"
            "  # runtime dependencies\n"
            "  - cairocffi\n"
            "  - c-compiler\n"
            "  - cxx-compiler\n"
            "  - contourpy>=1.0.1\n"
            "  - cycler>=0.10.0\n"
            "  - fonttools>=4.22.0\n"
            "  - pip\n"
            "  - pip:\n"
            "    - mpl-sphinx-theme~=3.8.0\n"
            "    - sphinxcontrib-video>=0.2.1\n"
            "    - types-pkg_resources\n"
            "    - pikepdf\n"
            "  # testing\n"
            "  - types-pkg_resources\n"
            "  - black<24\n"
            "  - coverage\n"
            "  - tox\n"
        )
        expected_env_yaml = (
            "# To set up a development environment using conda run:\n"
            "#\n"
            "#   conda env create -f environment.yml\n"
            "#   conda activate mpl-dev\n"
            '#   pip install --verbose --no-build-isolation --editable ".[dev]"\n'
            "#\n"
            "---\n"
            "name: matplotlib-master\n"
            "channels:\n"
            "  - conda-forge\n"
            "dependencies:\n"
            "  # runtime dependencies\n"
            "  - cairocffi\n"
            "  - c-compiler\n"
            "  - cxx-compiler\n"
            "  - contourpy>=1.0.1\n"
            "  - cycler>=0.10.0\n"
            "  - fonttools>=4.22.0\n"
            "  - pip\n"
            "  - pip:\n"
            "    - mpl-sphinx-theme~=3.8.0\n"
            "    - sphinxcontrib-video>=0.2.1\n"
            "    - types-setuptools\n"  # should be replaced
            "    - pikepdf\n"
            "  # testing\n"
            "  - types-pkg_resources\n"  # should not be modified
            "  - black<24\n"
            "  - coverage\n"
            "  - tox\n"
        )
        cleaned = clean_environment_yml(env_yaml)
        self.assertEqual(cleaned, expected_env_yaml)

    def test_environment_yml_cleaner_version_specifiers(self):
        """Test environment.yml cleaning with various version specifiers in pip section"""
        env_yaml = (
            "name: test-env\n"
            "dependencies:\n"
            "  - pip:\n"
            "    - types-pkg_resources==1.0.0\n"
            "    - test-package-1\n"
            "    - types-pkg_resources>=2.0.0\n"
            "    - test-package-2\n"
            "    - types-pkg_resources<=3.0.0\n"
            "    - test-package-3\n"
            "    - types-pkg_resources>1.5.0\n"
            "    - test-package-4\n"
            "    - types-pkg_resources<4.0.0\n"
            "    - test-package-5\n"
            "    - types-pkg_resources~=2.1.0\n"
            "    - test-package-6\n"
            "    - types-pkg_resources!=1.9.0\n"
            "    - test-package-7\n"
            "    - types-pkg_resources==1.0.0.dev0\n"
            "    - test-package-8\n"
            "    - types-pkg_resources\n"
            "    - test-package-9\n"
            "    - other-package==1.0.0\n"
        )
        expected_env_yaml = (
            "name: test-env\n"
            "dependencies:\n"
            "  - pip:\n"
            "    - types-setuptools\n"
            "    - test-package-1\n"
            "    - types-setuptools\n"
            "    - test-package-2\n"
            "    - types-setuptools\n"
            "    - test-package-3\n"
            "    - types-setuptools\n"
            "    - test-package-4\n"
            "    - types-setuptools\n"
            "    - test-package-5\n"
            "    - types-setuptools\n"
            "    - test-package-6\n"
            "    - types-setuptools\n"
            "    - test-package-7\n"
            "    - types-setuptools\n"
            "    - test-package-8\n"
            "    - types-setuptools\n"
            "    - test-package-9\n"
            "    - other-package==1.0.0\n"
        )
        cleaned = clean_environment_yml(env_yaml)
        self.assertEqual(cleaned, expected_env_yaml)

    def test_environment_yml_cleaner_no_pip_section(self):
        """Test environment.yml cleaning when there's no pip section"""
        env_yaml = (
            "name: test-env\n"
            "dependencies:\n"
            "  - types-pkg_resources==1.0.0\n"
            "  - python=3.9\n"
        )
        cleaned = clean_environment_yml(env_yaml)
        self.assertEqual(cleaned, env_yaml)

    def test_requirements_txt_cleaner_version_specifiers(self):
        """Test requirements.txt cleaning with various version specifiers"""
        requirements = (
            "types-pkg_resources==1.0.0\n"
            "test-package-1\n"
            "types-pkg_resources>=2.0.0\n"
            "test-package-2\n"
            "types-pkg_resources<=3.0.0\n"
            "test-package-3\n"
            "types-pkg_resources>1.5.0\n"
            "test-package-4\n"
            "types-pkg_resources<4.0.0\n"
            "test-package-5\n"
            "types-pkg_resources~=2.1.0\n"
            "test-package-6\n"
            "types-pkg_resources!=1.9.0\n"
            "test-package-7\n"
            "types-pkg_resources==1.0.0.dev0\n"
            "test-package-8\n"
            "types-pkg_resources\n"
            "test-package-9\n"
            "other-package==1.0.0\n"
        )
        expected_requirements = (
            "types-setuptools\n"
            "test-package-1\n"
            "types-setuptools\n"
            "test-package-2\n"
            "types-setuptools\n"
            "test-package-3\n"
            "types-setuptools\n"
            "test-package-4\n"
            "types-setuptools\n"
            "test-package-5\n"
            "types-setuptools\n"
            "test-package-6\n"
            "types-setuptools\n"
            "test-package-7\n"
            "types-setuptools\n"
            "test-package-8\n"
            "types-setuptools\n"
            "test-package-9\n"
            "other-package==1.0.0\n"
        )
        cleaned = clean_requirements(requirements)
        self.assertEqual(cleaned, expected_requirements)
