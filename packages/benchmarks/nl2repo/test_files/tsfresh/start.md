## Introduction and Goals of the tsfresh Project

### Introduction
tsfresh is a Python library specifically designed for time series feature extraction, with the full name "Time Series Feature extraction based on scalable hypothesis tests". By combining well-established algorithms from statistics, time series analysis, signal processing, and nonlinear dynamics, this library offers systematic time series feature extraction capabilities and is equipped with powerful feature selection algorithms. tsfresh extends the concept of "time series" to its broadest sense, capable of handling any type of sampled data and even event sequences.

### Goals
The goal of tsfresh is to become a leading tool in the field of time series feature engineering. By automating the feature extraction process, it aims to free data scientists from the cumbersome task of feature engineering, allowing them to devote more time to model optimization and algorithm research. tsfresh ensures that the extracted features are meaningful by providing statistically correct and mathematically rigorous feature selection methods, avoiding overfitting and spurious correlations, and thereby building more reliable time series machine learning models.

### Core Functions
- **Automated Feature Extraction**: Automatically extracts hundreds of features from time series, including basic statistical features (such as the number of peaks, mean, and maximum) and complex features (such as time reversal symmetry statistics).
- **Intelligent Feature Filtering**: Based on hypothesis testing theory and multiple testing procedures, it mathematically controls the proportion of irrelevant features, avoiding the extraction of features that are useless for machine learning tasks.
- **Statistical Rigor**: Uses the p-value method to evaluate the importance of each feature, especially suitable for situations where the number of features far exceeds the number of samples.
- **Multi-Scenario Support**: Supports both supervised learning (classification, regression) and unsupervised learning (anomaly detection) tasks.
- **Distributed Computing**: Supports running on local machines and cluster environments, improving the efficiency of large-scale data processing.
- **Ecosystem Integration**: Fully compatible with scikit-learn, pandas, and numpy, making it easy to integrate into existing workflows.
- **Scalability**: Allows users to easily add custom feature extraction methods, building the largest Python feature extraction method library.

## Natural Language Instruction (Prompt)

### Project Overview
Please create a Python project named tsfresh to implement a time series feature extraction library. The project should include the following functions:

1. **Feature Extractor**: Capable of extracting and calculating hundreds of features from the input time series data, supporting basic statistical features (such as mean, variance, number of peaks) and complex features (such as time reversal symmetry statistics, spectral features, etc.). The extraction result should be in the form of a pandas DataFrame or an equivalent analyzable format.

2. **Feature Selector**: Implement functions (or scripts) that can select relevant features based on statistical hypothesis testing, including both supervised and unsupervised learning scenarios. It should support multiple statistical test methods (such as Mann-Whitney U test, Fisher exact test, etc.), multiple test corrections (such as Benjamini-Yekutieli procedure), and custom feature selection strategies.

3. **Special Structure Handling**: Special handling for multivariate time series, event sequences, and irregularly sampled data, such as supporting time series grouped by ID, handling missing values, and supporting feature extraction for different time series types.

4. **Interface Design**: Design independent command-line interfaces or function interfaces for each functional module (such as feature extraction, feature selection, data preprocessing, result postprocessing, etc.), supporting terminal calls for testing. Each module should define clear input and output formats.

5. **Examples and Evaluation Scripts**: Provide example code and test cases to demonstrate how to use the `extract_features()` and `select_features()` functions for feature extraction and selection (for example, `extract_features(timeseries_data, column_id='id', column_sort='time')` should return a feature matrix).

6. **Core File Requirements**: The project must include a complete `setup.py` file, which not only configures the project as an installable package (supporting `pip install`) but also declares a complete list of dependencies (including core libraries such as `pandas >= 1.3.0`, `numpy >= 1.20.0`, `scipy >= 1.7.0`, `scikit-learn >= 1.0.0`, `statsmodels >= 0.13.0`, `pywt >= 1.1.0`, `pytest`, etc.). The `setup.py` file can verify whether all functional modules work properly. At the same time, it is necessary to provide `tsfresh/__init__.py` as a unified API entry, importing core functions such as `extract_features`, `select_features`, `calculate_relevance_table`, `combine_relevance_tables`, `get_feature_type`, `infer_ml_task` from the `feature_extraction` and `feature_selection` modules, exporting configuration classes such as `ComprehensiveFCParameters`, `MinimalFCParameters`, `ClusterDaskDistributor`, `IterableDistributorBaseClass`, `LocalDaskDistributor`, `MapDistributor`, `MultiprocessingDistributor`, etc., and providing version information, enabling users to access all major functions through simple statements such as `from tsfresh import ...`, `from tsfresh.feature_extractions/defaults/utilities/examples/transformers`. In `feature_calculators.py`, there should be various feature calculation functions to extract different types of time series features.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.18

### Core Dependency Library Versions
```Plain
attrs                     25.3.0
certifi                   2025.8.3
charset-normalizer        3.4.3
click                     8.2.1
cloudpickle               3.1.1
coverage                  7.10.4
dask                      2025.7.0
distributed               2025.7.0
exceptiongroup            1.3.0
execnet                   2.1.1
fastjsonschema            2.21.2
fsspec                    2025.7.0
idna                      3.10
importlib_metadata        8.7.0
iniconfig                 2.1.0
Jinja2                    3.1.6
joblib                    1.5.1
jsonschema                4.25.1
jsonschema-specifications 2025.4.1
jupyter_core              5.8.1
llvmlite                  0.44.0
locket                    1.0.0
MarkupSafe                3.0.2
mock                      5.2.0
msgpack                   1.1.1
nbformat                  5.10.4
numba                     0.61.2
numpy                     2.2.6
packaging                 25.0
pandas                    2.3.2
partd                     1.4.2
patsy                     1.0.1
pip                       25.2
platformdirs              4.3.8
pluggy                    1.6.0
psutil                    7.0.0
pyarrow                   21.0.0
Pygments                  2.19.2
pytest                    8.4.1
pytest-cov                6.2.1
pytest-xdist              3.8.0
python-dateutil           2.9.0.post0
pytz                      2025.2
PyWavelets                1.8.0
PyYAML                    6.0.2
referencing               0.36.2
requests                  2.32.5
rpds-py                   0.27.0
scikit-learn              1.7.1
scipy                     1.15.3
setuptools                65.5.1
six                       1.17.0
sortedcontainers          2.4.0
statsmodels               0.14.5
stumpy                    1.13.0
tblib                     3.1.0
threadpoolctl             3.6.0
tomli                     2.2.1
toolz                     1.0.0
tornado                   6.5.2
tqdm                      4.67.1
traitlets                 5.14.3
typing_extensions         4.14.1
tzdata                    2025.2
urllib3                   2.5.0
wheel                     0.45.1
zict                      3.0.0
zipp                      3.23.0
```

## tsfresh Project Architecture

### Project Directory Structure
```Plain
workspace/
├── .coveragerc
├── .gitignore
├── .pre-commit-config.yaml
├── .readthedocs.yml
├── AUTHORS.rst
├── CHANGES.rst
├── Dockerfile
├── Dockerfile.testing
├── LICENSE.txt
├── Makefile
├── README.md
├── docs
│   ├── Makefile
│   ├── _static
│   │   ├── .gitignore
│   │   ├── theme_override.css
│   ├── _templates
│   │   ├── module_functions_template.rst
│   ├── api
│   │   ├── modules.rst
│   │   ├── tsfresh.convenience.rst
│   │   ├── tsfresh.examples.rst
│   │   ├── tsfresh.feature_extraction.rst
│   │   ├── tsfresh.feature_selection.rst
│   │   ├── tsfresh.rst
│   │   ├── tsfresh.scripts.rst
│   │   ├── tsfresh.transformers.rst
│   │   ├── tsfresh.utilities.rst
│   ├── authors.rst
│   ├── changes.rst
│   ├── conf.py
│   ├── images
│   │   ├── feature_extraction_process_20160815_mc_1.png
│   │   ├── introduction_ts_exa.png
│   │   ├── introduction_ts_exa_features.png
│   │   ├── rolling_mechanism_1.png
│   │   ├── rolling_mechanism_2.png
│   │   ├── rolling_mechanism_drawio_template.xml
│   │   ├── ts_example_robot_failures_fail.png
│   │   ├── ts_example_robot_failures_nofail.png
│   │   ├── tsfresh_logo.svg
│   ├── index.rst
│   ├── license.rst
│   ├── text
│   │   ├── data_formats.rst
│   │   ├── faq.rst
│   │   ├── feature_calculation.rst
│   │   ├── feature_extraction_settings.rst
│   │   ├── feature_filtering.rst
│   │   ├── forecasting.rst
│   │   ├── how_to_add_custom_feature.rst
│   │   ├── how_to_contribute.rst
│   │   ├── introduction.rst
│   │   ├── large_data.rst
│   │   ├── list_of_features.rst
│   │   ├── quick_start.rst
│   │   ├── sklearn_transformers.rst
│   │   └── tsfresh_on_a_cluster.rst
├── notebooks
│   ├── 01 Feature Extraction and Selection.ipynb
│   ├── 02 sklearn Pipeline.ipynb
│   ├── 03 Feature Extraction Settings.ipynb
│   ├── 04 Multiclass Selection Example.ipynb
│   ├── 05 Timeseries Forecasting.ipynb
│   ├── advanced
│   │   ├── 05 Timeseries Forecasting (multiple ids).ipynb
│   │   ├── compare-runtimes-of-feature-calculators.ipynb
│   │   ├── feature_extraction_with_datetime_index.ipynb
│   │   ├── friedrich_coefficients.ipynb
│   │   ├── inspect_dft_features.ipynb
│   │   ├── perform-PCA-on-extracted-features.ipynb
│   │   ├── stocks.png
│   │   ├── visualize-benjamini-yekutieli-procedure.ipynb
│   ├── pipeline.pkl
│   ├── stocks.png
├── setup.cfg
├── setup.py
└── tsfresh
    ├── __init__.py
    ├── convenience
    │   ├── __init__.py
    │   ├── bindings.py
    │   ├── relevant_extraction.py
    ├── defaults.py
    ├── examples
    │   ├── __init__.py
    │   ├── driftbif_simulation.py
    │   ├── har_dataset.py
    │   ├── robot_execution_failures.py
    ├── feature_extraction
    │   ├── __init__.py
    │   ├── data.py
    │   ├── extraction.py
    │   ├── feature_calculators.py
    │   ├── settings.py
    ├── feature_selection
    │   ├── __init__.py
    │   ├── relevance.py
    │   ├── selection.py
    │   ├── significance_tests.py
    ├── scripts
    │   ├── __init__.py
    │   ├── data.txt
    │   ├── measure_execution_time.py
    │   ├── run_tsfresh.py
    │   ├── test_timing.py
    ├── transformers
    │   ├── __init__.py
    │   ├── feature_augmenter.py
    │   ├── feature_selector.py
    │   ├── per_column_imputer.py
    │   ├── relevant_feature_augmenter.py
    └── utilities
        ├── __init__.py
        ├── dataframe_functions.py
        ├── distribution.py
        ├── profiling.py
        └── string_manipulation.py

```

## API Usage Guide

> **📋 Documentation Navigation Guide**
> 
> This API usage guide is divided into two main sections:
> 1. **Core API** - Provides import statements and quick reference for all APIs
> 2. **Detailed Interface Description** - Provides detailed functionality descriptions, parameter explanations, and usage examples for each API
> 
> For quick import statement lookup, refer to the first section; for specific usage details, jump to the detailed descriptions in the second section.

### Core API

#### 1. API Overview
This section contains the complete API reference for the tsfresh library, including:
- **Core Functions**: Main functionality for feature extraction, feature selection, etc.
- **Configuration Classes**: Parameter settings and configuration objects  
- **Utility Functions**: Data processing and auxiliary functionality
- **Distributed Computing**: Parallel and distributed execution support
- **Example Data**: Built-in test datasets

Each API component in the detailed descriptions below includes:
- Corresponding import statements
- Detailed functionality descriptions
- Parameter descriptions and usage examples
---

### Detailed Interface Description of Main APIs and Configuration Classes

#### 1. `extract_features()` Function - Batch Extraction of Time Series Features

**Import Statement**:
```python
from typing import Union
import pandas as pd
from tsfresh import extract_features
from tsfresh.feature_extraction.extraction import extract_features
from tsfresh.feature_extraction import (
    MinimalFCParameters,
    ComprehensiveFCParameters,
    EfficientFCParameters,
)
```

**Functionality**:
Automatically extracts multiple features such as statistical, spectral, and nonlinear features in batches from the input time series data (supporting multiple groups, multiple variables, with ID and timestamp), and returns a feature matrix.

**Function Signature**:
```python
def extract_features(
    timeseries_container: Union[pd.DataFrame, dict],
    column_id: str = None,
    column_sort: str = None,
    column_kind: str = None,
    column_value: str = None,
    default_fc_parameters: dict = None,
    kind_to_fc_parameters: dict = None,
    n_jobs: int = 1,
    chunk_size: int = None,
    disable_progressbar: bool = False,
    impute_function: callable = None,
    show_warnings: bool = True,
    distributor: object = None,
    profile: bool = False,
    profiling_filename: str = None,
    return_df: bool = True,
    **kwargs
) -> pd.DataFrame
```

**Parameter Description**:
- `timeseries_container`: Input time series data (DataFrame or dict).
- `column_id`: Name of the grouping ID column.
- `column_sort`: Name of the time sorting column.
- `column_kind`: Name of the variable type column (used for multiple variables).
- `column_value`: Name of the value column.
- `default_fc_parameters`: Default feature extraction parameters (such as `MinimalFCParameters`).
- `kind_to_fc_parameters`: Feature parameters for different variables.
- `n_jobs`: Number of parallel computing processes.
- `chunk_size`: Size of the data block processed by each process.
- `disable_progressbar`: Whether to disable the progress bar.
- `impute_function`: Function for filling missing values.
- `show_warnings`: Whether to show warnings.
- `distributor`: Distributor for distributed computing.
- `profile`: Whether to enable performance profiling.
- `profiling_filename`: Filename for saving performance profiling results.
- `return_df`: Whether to return the result in DataFrame format.
- `**kwargs`: Other parameters.

**Return Value**:
A pandas DataFrame, where the rows are sample IDs, the columns are feature names, and the values are feature values.

---

#### 2. `extract_relevant_features()` Function - Automatic Extraction of Relevant Features

**Import Statement**:
```python
from typing import Union
import pandas as pd
from tsfresh import extract_relevant_features
from tsfresh.convenience.relevant_extraction import extract_relevant_features
```

**Functionality**:
Automatically extracts features that are most relevant to the target variable, suitable for tasks such as classification and regression, and integrates the feature selection process.

**Function Signature**:
```python
def extract_relevant_features(
    timeseries_container: Union[pd.DataFrame, dict],
    y: pd.Series,
    column_id: str = None,
    column_sort: str = None,
    column_kind: str = None,
    column_value: str = None,
    default_fc_parameters: dict = None,
    kind_to_fc_parameters: dict = None,
    n_jobs: int = 1,
    chunk_size: int = None,
    disable_progressbar: bool = False,
    impute_function: callable = None,
    show_warnings: bool = True,
    distributor: object = None,
    fdr_level: float = 0.05,
    test_for_binary_target_real_feature: str = None,
    profile: bool = False,
    profiling_filename: str = None,
    return_df: bool = True,
    **kwargs
) -> pd.DataFrame
```

**Parameter Description**:
- `timeseries_container`: Input time series data (DataFrame or dict).
- `y`: Target variable (Series, with sample IDs as indices).
- `column_id`: Name of the grouping ID column.
- `column_sort`: Name of the time sorting column.
- `column_kind`: Name of the variable type column (used for multiple variables).
- `column_value`: Name of the value column.
- `default_fc_parameters`: Default feature extraction parameters (such as `MinimalFCParameters`).
- `kind_to_fc_parameters`: Feature parameters for different variables.
- `n_jobs`: Number of parallel computing processes.
- `chunk_size`: Size of the data block processed by each process.
- `disable_progressbar`: Whether to disable the progress bar.
- `impute_function`: Function for filling missing values.
- `show_warnings`: Whether to show warnings.
- `distributor`: Distributor for distributed computing.
- `fdr_level`: Significance level for FDR control.
- `test_for_binary_target_real_feature`: Test method for binary targets and real-valued features.
- `profile`: Whether to enable performance profiling.
- `profiling_filename`: Filename for saving performance profiling results.
- `return_df`: Whether to return the result in DataFrame format.
- `**kwargs`: Other parameters.

**Return Value**:
A pandas DataFrame containing only features that are significantly relevant to the target variable.

---

#### 3. `select_features()` Function - Feature Selection

**Import Statement**:
```python
import pandas as pd
from tsfresh import select_features
from tsfresh.feature_selection.selection import select_features
```

**Functionality**:
Based on statistical tests, automatically selects features that are relevant to the target variable from the already extracted feature matrix.

**Function Signature**:
```python
def select_features(
    X: pd.DataFrame,
    y: pd.Series,
    fdr_level: float = 0.05,
    test_for_binary_target_real_feature: str = None,
    ml_task: str = None,
    n_jobs: int = 1,
    show_warnings: bool = True,
    return_indices: bool = False,
    **kwargs
) -> pd.DataFrame
```

**Parameter Description**:
- `X`: Feature matrix (DataFrame).
- `y`: Target variable (Series).
- `fdr_level`: Significance level for FDR control.
- `test_for_binary_target_real_feature`: Test method for binary targets and real-valued features.
- `ml_task`: Task type (such as "classification", "regression", etc.).
- `n_jobs`: Number of parallel processes.
- `show_warnings`: Whether to show warnings.
- `return_indices`: Whether to return the indices of the selected features.

**Return Value**:
A pandas DataFrame containing only the selected relevant features.

---

#### 4. `calculate_relevance_table()` Function - Calculation of Feature Relevance Table

**Import Statement**:
```python
import pandas as pd
from tsfresh.feature_selection.relevance import calculate_relevance_table
```

**Functionality**:
Calculates the relevance, p-value, and significance of each feature to the target variable, and outputs a detailed table.

**Function Signature**:
```python
def calculate_relevance_table(
    X: pd.DataFrame,
    y: pd.Series,
    ml_task: str = None,
    multiclass: bool = False,
    n_significant: int = 1,
    n_jobs: int = 1,
    show_warnings: bool = True,
    chunksize: int = None,
    test_for_binary_target_binary_feature: callable = None,
    test_for_binary_target_real_feature: callable = None,
    test_for_real_target_binary_feature: callable = None,
    test_for_real_target_real_feature: callable = None,
    fdr_level: float = 0.05,
    hypotheses_independent: bool = True,
    **kwargs
) -> pd.DataFrame
```

**Parameter Description**:
- `X`: Feature matrix (DataFrame).
- `y`: Target variable (Series).
- `ml_task`: Task type ("classification" or "regression"). If None, automatically inferred.
- `multiclass`: Whether to handle multiclass classification tasks.
- `n_significant`: Number of significant features to select (for multiclass).
- `n_jobs`: Number of parallel processes.
- `show_warnings`: Whether to show warnings.
- `chunksize`: Size of chunks for parallel processing.
- `test_for_binary_target_binary_feature`: Test method for binary targets and binary features.
- `test_for_binary_target_real_feature`: Test method for binary targets and real-valued features.
- `test_for_real_target_binary_feature`: Test method for real targets and binary features.
- `test_for_real_target_real_feature`: Test method for real targets and real-valued features.
- `fdr_level`: Significance level for FDR control.
- `hypotheses_independent`: Whether hypotheses are independent.
- `**kwargs`: Other parameters.

**Return Value**:
A pandas DataFrame containing information such as feature names, p-values, significance, and relevance.

---

#### 5. `combine_relevance_tables()` Function - Merging of Multiple Relevance Tables

**Import Statement**:
```python
from typing import List
import pandas as pd
from tsfresh.feature_selection.relevance import combine_relevance_tables
```

**Functionality**:
Merges multiple relevance tables, suitable for multi-task/multi-label scenarios.

**Function Signature**:
```python
def combine_relevance_tables(
    relevance_tables: List[pd.DataFrame],
    how: str = "intersection"
) -> pd.DataFrame
```

**Parameter Description**:
- `relevance_tables`: List of relevance tables.
- `how`: Merging method (such as "intersection", "union", etc.).

**Return Value**:
A pandas DataFrame, the merged relevance table.

---

#### 6. `get_feature_type()` Function - Feature Type Inference

**Import Statement**:
```python
import pandas as pd
from tsfresh.feature_selection.relevance import get_feature_type
```

**Functionality**:
Infers the type of features (such as binary, real-valued, constant, etc.).

**Function Signature**:
```python
def get_feature_type(
    X: pd.DataFrame
) -> dict
```

**Parameter Description**:
- `X`: Feature matrix.

**Return Value**:
A dictionary, where the keys are feature names and the values are types.

---

#### 7. `infer_ml_task()` Function - Inference of Machine Learning Task Type

**Import Statement**:
```python
import pandas as pd
from tsfresh.feature_selection.relevance import infer_ml_task
```

**Functionality**:
Automatically infers the task type (classification/regression) based on the target variable.

**Function Signature**:
```python
def infer_ml_task(
    y: pd.Series
) -> str
```

**Parameter Description**:
- `y`: Target variable.

**Return Value**:
A string, the task type (such as "classification", "regression", etc.).

---

#### 8. `feature_calculators` Module Overview

**Import Statement**:
```python
from tsfresh.feature_extraction import feature_calculators
from tsfresh.feature_extraction.feature_calculators import *
from tsfresh.feature_extraction.feature_calculators import set_property
```

**Functionality**:
The `feature_calculators` module contains all built-in feature calculation functions for extracting statistical, spectral, and nonlinear features from time series. Functions are categorized into simple calculators (single value output) and combiner calculators (multiple parameterized outputs).
---
#### 9. `_get_length_sequences_where()` Function - Length of Sequences Where Condition is True

**Import Statement**:
```python
import numpy as np
import itertools
from tsfresh.feature_extraction.feature_calculators import _get_length_sequences_where
```

**Functionality**:
This method calculates the length of all sub-sequences where the array x is either True or 1.

**Function Signature**:
```python
def _get_length_sequences_where(x) -> list
```

**Parameter Description**:
- `x`: An iterable containing only 1, True, 0 and False values

**Return Value**:
A list with the length of all sub-sequences where the array is either True or False. If no ones or Trues contained, the list [0] is returned.

---

#### 10. `_estimate_friedrich_coefficients()` Function - Friedrich Coefficients Estimation

**Import Statement**:
```python
import numpy as np
import pandas as pd
from tsfresh.feature_extraction.feature_calculators import _estimate_friedrich_coefficients
```

**Functionality**:
Coefficients of polynomial h(x), which has been fitted to the deterministic dynamics of Langevin model. As described by Friedrich et al. (2000): Physics Letters A 271, p. 217-222 "Extracting model equations from experimental data". For short time-series this method is highly dependent on the parameters.

**Function Signature**:
```python
def _estimate_friedrich_coefficients(x: np.ndarray, m: int, r: float) -> np.ndarray
```

**Parameter Description**:
- `x`: the time series to calculate the feature of
- `m`: order of polynomial to fit for estimating fixed points of dynamics
- `r`: number of quantiles to use for averaging

**Return Value**:
Coefficients of polynomial of deterministic dynamics (ndarray)

---

#### 11. `_aggregate_on_chunks()` Function - Aggregation on Chunks

**Import Statement**:
```python
import numpy as np
import pandas as pd
from tsfresh.feature_extraction.feature_calculators import _aggregate_on_chunks
```

**Functionality**:
Takes the time series x and constructs a lower sampled version of it by applying the aggregation function f_agg on consecutive chunks of length chunk_len.

**Function Signature**:
```python
def _aggregate_on_chunks(x: np.ndarray, f_agg: str, chunk_len: int) -> list
```

**Parameter Description**:
- `x`: the time series to calculate the aggregation of
- `f_agg`: The name of the aggregation function that should be an attribute of the pandas.Series
- `chunk_len`: The size of the chunks where to aggregate the time series

**Return Value**:
A list of the aggregation function over the chunks

---

#### 12. `set_property` Decorator

**Import Statement**:
```python
from tsfresh.feature_extraction.feature_calculators import set_property
```

**Functionality**:
The `set_property` decorator adds metadata to feature calculation functions for automatic discovery and configuration by the tsfresh framework.

**Usage**:
```python
@set_property("fctype", "simple")
def my_simple_feature(x):
    return np.mean(x)

@set_property("fctype", "combiner")  
def my_combiner_feature(x, param):
    return [("param_{}".format(p), calculate(x, p)) for p in param]
```

**Common Properties**:
- `fctype`: Function type ("simple" or "combiner")
- `minimal`: Whether function is included in minimal feature set
- `input`: Input requirements or constraints
- `index_type`: Type of index expected (if any)

**Parameter Types**:
- `x`: Input time series data (array-like)
- `param`: Parameter dictionary for combiner functions
- `r`, `m`, `lag`, `q`, `t`, `n`, `bins`, `tau`, `dimension`: Specific numeric parameters
- `normalize`, `isabs`: Boolean flags
- `f_agg`: Aggregation function name
- `value`, `min`, `max`: Value-specific parameters

---

#### 13. `FeatureAugmenter` - sklearn-Style Feature Augmentation Transformer

**Import Statement**:
```python
from tsfresh.transformers import FeatureAugmenter
from tsfresh.transformers.feature_augmenter import FeatureAugmenter
```

**Functionality**:
Bulk extracts time series features and adds them to the input table, compatible with the sklearn pipeline.

**Class Signature**:
```python
class FeatureAugmenter(BaseEstimator, TransformerMixin):
    def __init__(
        self,
        default_fc_parameters=None,
        kind_to_fc_parameters=None,
        column_id=None,
        column_sort=None,
        column_kind=None,
        column_value=None,
        timeseries_container=None,
        chunksize=CHUNKSIZE,
        n_jobs=N_PROCESSES,
        show_warnings=SHOW_WARNINGS,
        disable_progressbar=DISABLE_PROGRESSBAR,
        impute_function=IMPUTE_FUNCTION,
        profile=PROFILING,
        profiling_filename=PROFILING_FILENAME,
        profiling_sorting=PROFILING_SORTING,
    )
    def set_timeseries_container(self, timeseries_container)
    def fit(self, X=None, y=None)
    def transform(self, X)
```
**Parameter Description**:
See `extract_features` for details. The `set_timeseries_container` method needs to be called first.

---

#### 14. `RelevantFeatureAugmenter` - sklearn-Style Relevant Feature Augmentation Transformer

**Import Statement**:
```python
from tsfresh.transformers import RelevantFeatureAugmenter
from tsfresh.transformers.relevant_feature_augmenter import RelevantFeatureAugmenter
```

**Functionality**:
Automatically extracts and filters features that are relevant to the target variable, suitable for integration into the sklearn pipeline.

**Class Signature**:
```python
class RelevantFeatureAugmenter(BaseEstimator, TransformerMixin):
    def __init__(
        self,
        filter_only_tsfresh_features=True,
        default_fc_parameters=None,
        kind_to_fc_parameters=None,
        column_id=None,
        column_sort=None,
        column_kind=None,
        column_value=None,
        timeseries_container=None,
        chunksize=CHUNKSIZE,
        n_jobs=N_PROCESSES,
        show_warnings=SHOW_WARNINGS,
        disable_progressbar=DISABLE_PROGRESSBAR,
        profile=PROFILING,
        profiling_filename=PROFILING_FILENAME,
        profiling_sorting=PROFILING_SORTING,
        test_for_binary_target_binary_feature=...,
        test_for_binary_target_real_feature=...,
        test_for_real_target_binary_feature=...,
        test_for_real_target_real_feature=...,
        fdr_level=...,
        hypotheses_independent=...,
        ml_task="auto",
        multiclass=False,
        n_significant=1,
        multiclass_p_values="min",
    )
    def set_timeseries_container(self, timeseries_container)
    def fit(self, X, y)
    def transform(self, X)
    def fit_transform(self, X, y)
```
**Parameter Description**:
See `extract_relevant_features` and `select_features` for details.

---

#### 15. `FeatureSelector` - sklearn-Style Feature Selector

**Import Statement**:
```python
from tsfresh.transformers.feature_selector import FeatureSelector
```

**Functionality**:
Automatically filters features that are relevant to the target variable, supports the fit/transform interface, and is compatible with sklearn.

**Class Signature**:
```python
class FeatureSelector(BaseEstimator, TransformerMixin):
    def __init__(
        test_for_binary_target_binary_feature=...,
        test_for_binary_target_real_feature=...,
        test_for_real_target_binary_feature=...,
        test_for_real_target_real_feature=...,
        fdr_level=...,
        hypotheses_independent=...,
        n_jobs=...,
        chunksize=...,
        ml_task="auto",
        multiclass=False,
        n_significant=1,
        multiclass_p_values="min",
    )
    def fit(self, X, y)
    def transform(self, X)
```
**Attributes**:
- `relevant_features`: List of feature names selected during the training phase.
- `feature_importances_`: Feature importance scores.
- `p_values`: Feature p-values.

---

#### 16. `PerColumnImputer` - sklearn-Style Per-Column Missing Value Filler

**Import Statement**:
```python
from tsfresh.transformers.per_column_imputer import PerColumnImputer
```

**Functionality**:
Automatically fills NaN and inf values in a DataFrame column by column, supporting custom filling values.

**Class Signature**:
```python
class PerColumnImputer(BaseEstimator, TransformerMixin):
    def __init__(
        col_to_NINF_repl_preset=None,
        col_to_PINF_repl_preset=None,
        col_to_NAN_repl_preset=None,
    )
    def fit(self, X, y=None)
    def transform(self, X)
```
**Parameter Description**:
- `col_to_NINF_repl_preset`: Specifies the filling value for -inf.
- `col_to_PINF_repl_preset`: Specifies the filling value for +inf.
- `col_to_NAN_repl_preset`: Specifies the filling value for NaN.

---

#### 17. DataFrame Utility Functions

**Import Statement**:
```python
from tsfresh.utilities.dataframe_functions import (
    add_sub_time_series_index,
    check_for_nans_in_columns,
    get_ids,
    get_range_values_per_column,
    impute,
    impute_dataframe_range,
    impute_dataframe_zero,
    make_forecasting_frame,
    restrict_input_to_index,
    roll_time_series,
)
```

**Functionality**:
Utility functions for DataFrame and time series data manipulation, including missing value handling, data restructuring, and ID management.

**Function Descriptions**:
- **`add_sub_time_series_index(df_or_dict, sub_length, column_id, column_sort, column_kind=None)`**:
Adds sub time series indices to create rolling windows from time series data.
- **`check_for_nans_in_columns(df, columns=None)`**:
Checks whether the specified columns contain NaN values. If so, it raises an exception.
- **`get_ids(df_or_dict, column_id)`**:
Extracts unique IDs from DataFrame or dictionary format time series data.
- **`get_range_values_per_column(df)`**:
Calculates the range (max-min) for each numerical column in the DataFrame.
- **`impute(df)`**:
Replaces NaN/-inf/+inf in a DataFrame with the median/minimum/maximum of the column.
- **`impute_dataframe_range(df, col_to_max, col_to_min, col_to_median)`**:
Imputes missing values using specified range statistics for each column.
- **`impute_dataframe_zero(df)`**:
Replaces all NaN values in the DataFrame with zeros.
- **`make_forecasting_frame(x, kind, max_timeshift, rolling_direction=1)`**:
Creates a forecasting frame by rolling time series data for prediction tasks.
- **`restrict_input_to_index(df_or_dict, column_id, index)`**:
Restricts the index of a DataFrame or dictionary to the specified index.
- **`roll_time_series(df_or_dict, column_id, column_sort, column_kind=None, rolling_direction=1, max_timeshift=10, min_timeshift=1, chunksize=None, n_jobs=1, show_warnings=True, disable_progressbar=False, distributor=None)`**:
Creates rolling windows from time series data for feature extraction.

---

#### 18. Performance Monitoring API

**Import Statement**:
```python
from tsfresh.utilities.profiling import (
    end_profiling,
    get_n_jobs,
    set_n_jobs,
    start_profiling,
)
from tsfresh.utilities.distribution import (
    initialize_warnings_in_workers,
)
```

**Functionality**:
Functions for performance monitoring, profiling, and parallel processing configuration in tsfresh.

**Function Descriptions**:
- **`end_profiling(profiler, filename, sorting)`**:
Ends profiling session and saves results to specified file.
- **`get_n_jobs()`**:
Gets the current number of parallel processing processes.
- **`initialize_warnings_in_workers(show_warnings)`**:
Initializes warning display settings in distributed workers.
- **`set_n_jobs(n_jobs)`**:
Sets the number of parallel processing processes.
- **`start_profiling()`**:
Starts a profiling session for performance monitoring.

---

#### 19. String Processing Utilities

**Import Statement**:
```python
from tsfresh.utilities.string_manipulation import (
    add_parenthesis_if_string_value,
    convert_to_output_format,
    get_config_from_string,
)
```

**Functionality**:
Utility functions for string manipulation and parameter formatting, primarily used for feature name generation and parsing.

**Function Descriptions**:
- **`add_parenthesis_if_string_value(x)`**:
Adds parentheses around string values for proper formatting.
- **`convert_to_output_format(param: dict) -> str`**:
Converts a parameter dictionary into a feature name string.
- **`get_config_from_string(parts: list) -> dict`**:
Parses a parameter dictionary from a feature name string.

---

#### 20. Example Data API

**Import Statement**:
```python
from tsfresh.examples.driftbif_simulation import (
    load_driftbif,
    sample_tau,
    velocity,
)
from tsfresh.examples.har_dataset import (
    download_har_dataset,
    load_har_classes,
    load_har_dataset,
)
from tsfresh.examples.robot_execution_failures import (
    download_robot_execution_failures,
    load_robot_execution_failures,
)
```

**Functionality**:
Functions for downloading and loading example datasets commonly used for testing and demonstrating tsfresh functionality.

**Function Descriptions**:
- **`download_har_dataset(folder_name=...)`**:
Downloads the HAR human activity recognition dataset.
- **`download_robot_execution_failures(file_name=...)`**:
Downloads the robot execution failure dataset.
- **`load_driftbif(n, length, m, classification=True, kappa_3=1.0, seed=None)`**:
Loads the drift bifurcation simulation dataset for testing.
- **`load_har_classes(folder_name=...)`**:
Loads the HAR dataset class labels.
- **`load_har_dataset(folder_name=...)`**:
Loads the HAR dataset, returning a DataFrame.
- **`load_robot_execution_failures(multiclass=False, file_name=...)`**:
Loads the robot execution failure dataset, returning a DataFrame and a target Series.
- **`sample_tau(n, kappa_3, ratio, rel_increase)`**:
Samples time constants for drift bifurcation simulation.
- **`velocity(time, tau, kappa_3)`**:
Calculates velocity values for drift bifurcation simulation.

---


#### 21. Internal Functions and Helpers

**Import Statement**:
```python
# Note: Internal functions are for library development and advanced use cases
# Import specific functions as needed
from tsfresh.feature_selection.significance_tests import (
    target_binary_feature_binary_test,
    target_binary_feature_real_test,
    target_real_feature_binary_test,
    target_real_feature_real_test,
    __check_if_pandas_series,
    __check_for_binary_target,
    __check_for_binary_feature,
    _check_for_nans,
)
from tsfresh.feature_extraction.settings import (
    from_columns,
    include_function,
)
from tsfresh.utilities.distribution import (
    _function_with_partly_reduce,
)
```

**Functionality**:
Internal helper functions for library development, testing, and advanced use cases. These functions support the main tsfresh functionality but are typically not used directly by end users.

**Function Descriptions**:
- **Internal Helper Functions**:
  - **`_notebook_run()`**: Executes notebook for testing purposes
  - **`_binding_helper()`**, **`wrapped_feature_extraction()`**: Binding helper functions
  - **`_check_colname()`**, **`_check_nan()`**, **`_get_value_columns()`**: Data validation functions
  - **`_do_extraction()`**, **`_do_extraction_on_chunk()`**: Core extraction functions
  - **`_calculate_mp()`**: Matrix profile calculation
  - **`_calculate_relevance_table_for_implicit_target()`**: Internal relevance calculation
  - **`_combine()`**: Internal combination function
  - **`__check_if_pandas_series()`**: Series type checking
  - **`__check_for_binary_target()`**, **`__check_for_binary_feature()`**: Binary type checking
  - **`_check_for_nans()`**: NaN checking
  - **`_preprocess()`**: Internal preprocessing
  - **`_roll_out_time_series()`**: Time series rolling
  - **`mask_first()`**: Masking function
  - **`_add_id_column()`**: ID column addition
  - **`_function_with_partly_reduce()`**: Partial reduction function

- **Test Helper Functions**:
  - **`binary_series_with_nan()`**, **`real_series_with_nan()`**: Generate test series with NaN
  - **`binary_series()`**, **`real_series()`**: Generate test binary and real series
  - **`test_fdr_control()`**: Test FDR control functionality
  - **`set_random_seed()`**: Set random seed for testing
  - **`binary_target_not_related()`**, **`real_target_not_related()`**: Generate uncorrelated targets
  - **`test_relevant_augmentor_cross_validated()`**: Test cross-validated relevance

---

#### 22. Test Constants and Configuration

**Import Statement**:
```python
# Default configuration constants
from tsfresh.defaults import (
    CHUNKSIZE,
    N_PROCESSES,
    PROFILING,
    PROFILING_SORTING,
    PROFILING_FILENAME,
    IMPUTE_FUNCTION,
    DISABLE_PROGRESSBAR,
    SHOW_WARNINGS,
    PARALLELISATION,
    TEST_FOR_BINARY_TARGET_BINARY_FEATURE,
    TEST_FOR_BINARY_TARGET_REAL_FEATURE,
    TEST_FOR_REAL_TARGET_BINARY_FEATURE,
    TEST_FOR_REAL_TARGET_REAL_FEATURE,
    FDR_LEVEL,
    HYPOTHESES_INDEPENDENT,
    WRITE_SELECTION_REPORT,
    RESULT_DIR,
)

# Test data constants (for internal testing)
from tsfresh.examples.robot_execution_failures import (
    UCI_MLD_REF_MSG,
    UCI_MLD_REF_URL,
)
# Note: TEST_DATA_EXPECTED_TUPLES and WIDE_TEST_DATA_EXPECTED_TUPLES
# are defined in test files and not typically imported in production code
```

**Functionality**:
Default configuration constants and test data constants used throughout tsfresh for configuration management and testing.

**Constant Descriptions**:
- **Default Configuration Constants**:
  - **`CHUNKSIZE`**: Default chunk size for parallel processing
  - **`N_PROCESSES`**: Default number of processes for parallel execution
  - **`PROFILING`**, **`PROFILING_SORTING`**, **`PROFILING_FILENAME`**: Profiling configuration
  - **`IMPUTE_FUNCTION`**: Default function for imputing missing values
  - **`DISABLE_PROGRESSBAR`**, **`SHOW_WARNINGS`**: Display configuration
  - **`PARALLELISATION`**: Default parallelization method
  - **`TEST_FOR_BINARY_TARGET_BINARY_FEATURE`**, **`TEST_FOR_BINARY_TARGET_REAL_FEATURE`**: Statistical test configurations
  - **`TEST_FOR_REAL_TARGET_BINARY_FEATURE`**, **`TEST_FOR_REAL_TARGET_REAL_FEATURE`**: Statistical test configurations
  - **`FDR_LEVEL`**, **`HYPOTHESES_INDEPENDENT`**: False discovery rate parameters
  - **`WRITE_SELECTION_REPORT`**, **`RESULT_DIR`**: Output configuration

- **Test Data Constants**:
  - **`TEST_DATA_EXPECTED_TUPLES`**: Expected test data tuples for validation
  - **`WIDE_TEST_DATA_EXPECTED_TUPLES`**: Expected wide format test data tuples
  - **`UCI_MLD_REF_MSG`**: Reference message for UCI machine learning repository
  - **`UCI_MLD_REF_URL`**: Reference URL for UCI machine learning repository

- **Type Aliases and Loggers**:
  - **`_logger`**: Internal logger instances for different modules

---
#### 24. `TsData` - Time Series Data Access Interface

**Import Statement**:
```python
from tsfresh.feature_extraction.data import TsData
```

**Functionality**:
Base class that provides access to time series data for internal usage. Distributors will use this data class to apply functions on the data. All derived classes must either implement the `apply` method, which is used to apply the given function directly on the data or the __iter__ method, which can be used to get an iterator of Timeseries instances (which distributors can use to apply the function on). Other methods can be overwritten if a more efficient solution exists for the underlying data store.

**Class Signature**:
```python
class TsData:
    pass
```
**Parameter Description**:
- No parameters for this base class.

#### 25. `PartitionedTsData` - Partitioned Time Series Data

**Import Statement**:
```python
from tsfresh.feature_extraction.data import PartitionedTsData
```

**Functionality**:
Special class of TsData, which can be partitioned. Derived classes should implement __iter__ and __len__. Provides a pivot method to turn an iterable of tuples with three entries into a dataframe.

**Class Signature**:
```python
class PartitionedTsData(Iterable[Timeseries], Sized, TsData):
    def __init__(self, df, column_id)
    def pivot(self, results)
```
**Parameter Description**:
- `df`: The dataframe containing the time series data.
- `column_id`: The name of the column containing time series group ids.
- `results`: An iterable of tuples with three entries (chunk_id, variable, value) to be pivoted into a dataframe.

#### 26. `WideTsFrameAdapter` - Adapter for Wide Format DataFrames

**Import Statement**:
```python
from tsfresh.feature_extraction.data import WideTsFrameAdapter
```

**Functionality**:
Adapter for Pandas DataFrames in wide format, where multiple columns contain different time series for the same id. Implements the PartitionedTsData interface.

**Class Signature**:
```python
class WideTsFrameAdapter(PartitionedTsData):
    def __init__(self, df, column_id, column_sort, value_columns)
    def __len__(self)
    def __iter__(self)
```
**Parameter Description**:
- `df`: The data frame in wide format.
- `column_id`: The name of the column containing time series group ids.
- `column_sort`: The name of the column to sort on (optional).
- `value_columns`: List of column names to treat as time series values. If `None` or empty, all columns except `column_id` and `column_sort` will be used.

#### 27. `LongTsFrameAdapter` - Adapter for Long Format DataFrames

**Import Statement**:
```python
from tsfresh.feature_extraction.data import LongTsFrameAdapter
```

**Functionality**:
Adapter for Pandas DataFrames in long format, where different time series for the same id are labeled by column `column_kind`. Implements the PartitionedTsData interface.

**Class Signature**:
```python
class LongTsFrameAdapter(PartitionedTsData):
    def __init__(self, df, column_id, column_kind, column_value, column_sort)
    def __len__(self)
    def __iter__(self)
```
**Parameter Description**:
- `df`: The data frame in long format.
- `column_id`: The name of the column containing time series group ids.
- `column_kind`: The name of the column containing time series kinds for each id.
- `column_value`: The name of the column containing time series values. If `None`, try to guess it from the remaining, unused columns.
- `column_sort`: The name of the column to sort on (optional).

#### 28. `TsDictAdapter` - Adapter for Dictionary-Based Time Series Data

**Import Statement**:
```python
from tsfresh.feature_extraction.data import TsDictAdapter
```

**Functionality**:
Adapter for a dict, which maps different time series kinds to Pandas DataFrames. Implements the PartitionedTsData interface.

**Class Signature**:
```python
class TsDictAdapter(PartitionedTsData):
    def __init__(self, ts_dict, column_id, column_value, column_sort)
    def __iter__(self)
    def __len__(self)
```
**Parameter Description**:
- `ts_dict`: A dict of data frames where keys are time series kinds and values are the corresponding dataframes.
- `column_id`: The name of the column containing time series group ids.
- `column_value`: The name of the column containing time series values.
- `column_sort`: The name of the column to sort on (optional).

#### 29. `DaskTsAdapter` - Adapter for Dask DataFrames

**Import Statement**:
```python
from tsfresh.feature_extraction.data import DaskTsAdapter
```

**Functionality**:
Adapter for Dask DataFrames that can handle both wide and long format data. Implements the TsData interface and provides methods for applying functions on distributed data.

**Class Signature**:
```python
class DaskTsAdapter(TsData):
    def __init__(self, df, column_id, column_kind, column_value, column_sort)
    def apply(self, f, meta)
    def pivot(self, results)
```
**Parameter Description**:
- `df`: The Dask DataFrame containing the time series data.
- `column_id`: The name of the column containing time series group ids.
- `column_kind`: The name of the column containing time series kinds (optional).
- `column_value`: The name of the column containing time series values (optional).
- `column_sort`: The name of the column to sort on (optional).
- `f`: The function to apply on the data.
- `meta`: Metadata for the Dask computation.
- `results`: DataFrame with columns [id, variable, value] to be pivoted.

#### 30. `DataCreationTask` - Luigi Task for Creating Test Data

**Import Statement**:
```python
from tsfresh.scripts.measure_execution_time import DataCreationTask
```

**Functionality**:
Luigi task that creates random data for testing tsfresh performance. Generates a DataFrame with random time series data based on specified parameters.

**Class Signature**:
```python
class DataCreationTask(luigi.Task):
    num_ids = luigi.IntParameter(default=100)
    time_series_length = luigi.IntParameter()
    random_seed = luigi.IntParameter()

    def output(self)
    def run(self)
```
**Parameter Description**:
- `num_ids`: Number of different time series IDs to generate (default: 100).
- `time_series_length`: Length of each time series.
- `random_seed`: Seed for the random number generator.

#### 31. `TimingTask` - Luigi Task for Measuring Execution Time

**Import Statement**:
```python
from tsfresh.scripts.measure_execution_time import TimingTask
```

**Functionality**:
Luigi task that runs tsfresh with specific parameters and measures execution time. Used for performance benchmarking of individual feature calculators.

**Class Signature**:
```python
class TimingTask(luigi.Task):
    feature_parameter = luigi.DictParameter(hashed=True)
    n_jobs = luigi.IntParameter()
    try_number = luigi.IntParameter()

    def output(self)
    def run(self)
```
**Parameter Description**:
- `feature_parameter`: Dictionary of feature parameters to use for extraction.
- `n_jobs`: Number of parallel jobs to use.
- `try_number`: Trial number for multiple runs.

#### 32. `FullTimingTask` - Luigi Task for Full Feature Extraction Timing

**Import Statement**:
```python
from tsfresh.scripts.measure_execution_time import FullTimingTask
```

**Functionality**:
Luigi task that runs tsfresh with all calculators for comprehensive performance comparison. Measures the time required for full feature extraction.

**Class Signature**:
```python
class FullTimingTask(luigi.Task):
    n_jobs = luigi.IntParameter()

    def output(self)
    def run(self)
```
**Parameter Description**:
- `n_jobs`: Number of parallel jobs to use.

#### 33. `CombinerTask` - Luigi Task for Combining Results

**Import Statement**:
```python
from tsfresh.scripts.measure_execution_time import CombinerTask
```

**Functionality**:
Luigi task that collects all timing tasks into a single result CSV file. Coordinates the execution of multiple timing tasks and combines their results.

**Class Signature**:
```python
class CombinerTask(luigi.Task):
    def complete(self)
    def requires(self)
    def output(self)
    def run(self)
```
**Parameter Description**:
- No specific parameters for this coordination task.

#### 34. `variance_larger_than_standard_deviation()` Function - Check if Variance is Larger than Standard Deviation

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import variance_larger_than_standard_deviation
```

**Functionality**: 
Checks if the variance of a time series is higher than its standard deviation. This is equivalent to checking if the variance is larger than 1.

**Function Signature**: 
```python 
def variance_larger_than_standard_deviation(x: np.ndarray) -> bool
```

**Parameter Description**: 
- `x`: The time series to calculate the feature of.

**Return Value**: 
A boolean value indicating whether the variance is greater than the standard deviation.

---

#### 34. `ratio_beyond_r_sigma()` Function - Ratio Beyond R Sigma

**Import Statement**: 
```python 
import numpy as np
import pandas as pd
from tsfresh.feature_extraction.feature_calculators import ratio_beyond_r_sigma
```

**Functionality**: 
Calculates the ratio of values that are more than r times the standard deviation away from the mean of the time series.

**Function Signature**: 
```python 
def ratio_beyond_r_sigma(x: np.ndarray, r: float) -> float
```

**Parameter Description**: 
- `x`: The time series to calculate the feature of.
- `r`: The ratio to compare with (multiplier for standard deviation).

**Return Value**: 
The ratio of values that exceed r times the standard deviation from the mean.

---

#### 35. `large_standard_deviation()` Function - Large Standard Deviation Check

**Import Statement**: 
```python 
import numpy as np
import pandas as pd
from tsfresh.feature_extraction.feature_calculators import large_standard_deviation
```

**Functionality**: 
Checks if the standard deviation of a time series is larger than r times the range (difference between max and min) of the time series.

**Function Signature**: 
```python 
def large_standard_deviation(x: np.ndarray, r: float) -> bool
```

**Parameter Description**: 
- `x`: The time series to calculate the feature of.
- `r`: The percentage of the range to compare with.

**Return Value**: 
A boolean value indicating whether the standard deviation is larger than r times the range.

---

#### 36. `symmetry_looking()` Function - Symmetry Looking Check

**Import Statement**: 
```python 
import numpy as np
import pandas as pd
from tsfresh.feature_extraction.feature_calculators import symmetry_looking
```

**Functionality**: 
Checks if the distribution of a time series looks symmetric by comparing the absolute difference between mean and median with r times the range.

**Function Signature**: 
```python 
def symmetry_looking(x: np.ndarray, param: list) -> List[Tuple[str, bool]]
```

**Parameter Description**: 
- `x`: The time series to calculate the feature of.
- `param`: Contains dictionaries {"r": x} where x (float) is the percentage of the range to compare with.

**Return Value**: 
A list of tuples with the parameter settings and boolean results indicating symmetry.

---

#### 37. `cid_ce()` Function - Complexity-Invariant Distance

**Import Statement**: 
```python 
import numpy as np
import pandas as pd
from tsfresh.feature_extraction.feature_calculators import cid_ce
```

**Functionality**: 
Calculates an estimate for time series complexity. A more complex time series has more peaks and valleys.

**Function Signature**: 
```python 
def cid_ce(x: np.ndarray, normalize: bool) -> float
```

**Parameter Description**: 
- `x`: The time series to calculate the feature of.
- `normalize`: Should the time series be z-transformed before calculation.

**Return Value**: 
The complexity-invariant distance value.

---

#### 38. `percentage_of_reoccurring_datapoints_to_all_datapoints()` Function - Percentage of Reoccurring Data Points

**Import Statement**: 
```python 
import numpy as np
import pandas as pd
from tsfresh.feature_extraction.feature_calculators import percentage_of_reoccurring_datapoints_to_all_datapoints
```

**Functionality**: 
Returns the percentage of non-unique data points in the time series.

**Function Signature**: 
```python 
def percentage_of_reoccurring_datapoints_to_all_datapoints(x: np.ndarray) -> float
```

**Parameter Description**: 
- `x`: The time series to calculate the feature of.

**Return Value**: 
The ratio of reoccurring data points to all data points.

---

#### 39. `sum_of_reoccurring_values()` Function - Sum of Reoccurring Values

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import sum_of_reoccurring_values
```

**Functionality**: 
Returns the sum of all values that are present in the time series more than once.

**Function Signature**: 
```python 
def sum_of_reoccurring_values(x: np.ndarray) -> float
```

**Parameter Description**: 
- `x`: The time series to calculate the feature of.

**Return Value**: 
The sum of reoccurring values (each counted once regardless of frequency).

---

#### 40. `sum_of_reoccurring_data_points()` Function - Sum of Reoccurring Data Points

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import sum_of_reoccurring_data_points
```

**Functionality**: 
Returns the sum of all data points that are present in the time series more than once.

**Function Signature**: 
```python 
def sum_of_reoccurring_data_points(x: np.ndarray) -> float
```

**Parameter Description**: 
- `x`: The time series to calculate the feature of.

**Return Value**: 
The sum of reoccurring data points (each counted as often as it appears).

---

#### 41. `ratio_value_number_to_time_series_length()` Function - Ratio of Unique Values to Series Length

**Import Statement**: 
```python 
import numpy as np
import pandas as pd
from tsfresh.feature_extraction.feature_calculators import ratio_value_number_to_time_series_length
```

**Functionality**: 
Returns a factor which is 1 if all values in the time series occur only once, and below one if this is not the case.

**Function Signature**: 
```python 
def ratio_value_number_to_time_series_length(x: np.ndarray) -> float
```

**Parameter Description**: 
- `x`: The time series to calculate the feature of.

**Return Value**: 
The ratio of unique values to total values in the time series.

---

#### 42. `index_mass_quantile()` Function - Index Mass Quantile

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import index_mass_quantile
```

**Functionality**: 
Calculates the relative index of a time series where q% of the mass of the series lies left of that index.

**Function Signature**: 
```python 
def index_mass_quantile(x: np.ndarray, param: list) -> List[Tuple[str, float]]
```

**Parameter Description**: 
- `x`: The time series to calculate the feature of.
- `param`: Contains dictionaries {"q": x} where x is a float representing the quantile.

**Return Value**: 
A list of tuples with quantile parameters and their corresponding relative indices.

---

#### 43. `max_langevin_fixed_point()` Function - Maximum Langevin Fixed Point

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import max_langevin_fixed_point
```

**Functionality**: 
Estimates the largest fixed point of dynamics from polynomial fitted to the deterministic dynamics of Langevin model.

**Function Signature**: 
```python 
def max_langevin_fixed_point(x: np.ndarray, r: float, m: int) -> float
```

**Parameter Description**: 
- `x`: The time series to calculate the feature of.
- `r`: Number of quantiles to use for averaging.
- `m`: Order of polynomial to fit for estimating fixed points of dynamics.

**Return Value**: 
The largest fixed point of deterministic dynamics.

---

#### 44. `energy_ratio_by_chunks()` Function - Energy Ratio by Chunks

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import energy_ratio_by_chunks
```

**Functionality**: 
Calculates the sum of squares of a specific chunk expressed as a ratio with the sum of squares over the whole series.

**Function Signature**: 
```python 
def energy_ratio_by_chunks(x: np.ndarray, param: list) -> List[Tuple[str, float]]
```

**Parameter Description**: 
- `x`: The time series to calculate the feature of.
- `param`: Contains dictionaries {"num_segments": N, "segment_focus": i} with N, i both integers.

**Return Value**: 
A list of tuples with segment parameters and their corresponding energy ratios.

---

#### 45. `to_tsdata()` Function - Convert to Time Series Data

**Import Statement**: 
```python 
import pandas as pd
from tsfresh.feature_extraction.data import to_tsdata
```

**Functionality**: 
Wraps supported data formats as a TsData object, i.e., an iterable of individual time series.

**Function Signature**: 
```python 
def to_tsdata(
    df: pd.DataFrame, 
    column_id: str = None, 
    column_kind: str = None, 
    column_value: str = None, 
    column_sort: str = None
) -> TsData
```

**Parameter Description**: 
- `df`: One of the supported input formats (DataFrame, dict, or TsData).
- `column_id`: The name of the id column to group by.
- `column_kind`: The name of the column keeping record on the kind of the value.
- `column_value`: The name for the column keeping the value itself.
- `column_sort`: The name for the column to sort on.

**Return Value**: 
A data adapter (TsData object) that can be iterated over as individual time series.

---

#### 46. `simulate_with_length()` Function - Simulate with Length

**Import Statement**: 
```python 
import pandas as pd
from tsfresh.scripts.test_timing import simulate_with_length
```

**Functionality**: 
Simulates feature extraction with a specified length of data and measures the duration.

**Function Signature**: 
```python 
def simulate_with_length(length: int, df: pd.DataFrame) -> dict
```

**Parameter Description**: 
- `length`: The length of data to extract features from.
- `df`: The DataFrame to extract features from.

**Return Value**: 
A dictionary containing the length and duration of the feature extraction.

---

#### 47. `plot_results()` Function - Plot Timing Results

**Import Statement**: 
```python 
from tsfresh.scripts.test_timing import plot_results
```

**Functionality**: 
Plots the timing results from feature extraction tests, showing duration and speedup comparisons.

**Function Signature**: 
```python 
def plot_results() -> None
```

**Parameter Description**: 
None

**Return Value**: 
None. Generates and saves a plot of timing results.

---

#### 48. `measure_temporal_complexity()` Function - Measure Temporal Complexity

**Import Statement**: 
```python 
from tsfresh.scripts.test_timing import measure_temporal_complexity
```

**Functionality**: 
Measures the temporal complexity of feature extraction by testing with different data lengths.

**Function Signature**: 
```python 
def measure_temporal_complexity() -> None
```

**Parameter Description**: 
None

**Return Value**: 
None. Measures and saves temporal complexity data.

---

#### 49. `_feature_extraction_on_chunk_helper()` Function - Feature Extraction Helper

**Import Statement**: 
```python 
from tsfresh.convenience.bindings import _feature_extraction_on_chunk_helper
```

**Functionality**: 
Helper function wrapped around _do_extraction_on_chunk to use the correct format of the "chunk" and output a pandas dataframe.

**Function Signature**: 
```python 
def _feature_extraction_on_chunk_helper(
    df: pd.DataFrame,
    column_id: str,
    column_kind: str,
    column_sort: str,
    column_value: str,
    default_fc_parameters: dict,
    kind_to_fc_parameters: dict
) -> pd.DataFrame
```

**Parameter Description**: 
- `df`: The DataFrame to extract features from.
- `column_id`: The name of the id column to group by.
- `column_kind`: The name of the column keeping record on the kind of the value.
- `column_sort`: The name of the sort column.
- `column_value`: The name for the column keeping the value itself.
- `default_fc_parameters`: Mapping from feature calculator names to parameters.
- `kind_to_fc_parameters`: Mapping from kind names to feature calculator parameters.

**Return Value**: 
A pandas DataFrame with extracted features.

---

#### 50. `dask_feature_extraction_on_chunk()` Function - Dask Feature Extraction

**Import Statement**: 
```python 
from tsfresh.convenience.bindings import dask_feature_extraction_on_chunk
```

**Functionality**: 
Extracts features on a grouped dask dataframe given the column names and extraction settings.

**Function Signature**: 
```python 
def dask_feature_extraction_on_chunk(
    df,
    column_id: str,
    column_kind: str,
    column_value: str,
    column_sort: str = None,
    default_fc_parameters: dict = None,
    kind_to_fc_parameters: dict = None
) -> dd.DataFrame
```

**Parameter Description**: 
- `df`: A dask dataframe grouped by id and kind.
- `column_id`: The name of the id column to group by.
- `column_kind`: The name of the column keeping record on the kind of the value.
- `column_value`: The name for the column keeping the value itself.
- `column_sort`: The name of the sort column.
- `default_fc_parameters`: Mapping from feature calculator names to parameters.
- `kind_to_fc_parameters`: Mapping from kind names to feature calculator parameters.

**Return Value**: 
A dask dataframe with the columns column_id, "variable" and "value".

---

#### 51. `spark_feature_extraction_on_chunk()` Function - Spark Feature Extraction

**Import Statement**: 
```python 
from tsfresh.convenience.bindings import spark_feature_extraction_on_chunk
```

**Functionality**: 
Extracts features on a grouped spark dataframe given the column names and extraction settings.

**Function Signature**: 
```python 
def spark_feature_extraction_on_chunk(
    df,
    column_id: str,
    column_kind: str,
    column_value: str,
    column_sort: str = None,
    default_fc_parameters: dict = None,
    kind_to_fc_parameters: dict = None
) -> pyspark.sql.DataFrame
```

**Parameter Description**: 
- `df`: A spark dataframe grouped by id and kind.
- `column_id`: The name of the id column to group by.
- `column_kind`: The name of the column keeping record on the kind of the value.
- `column_value`: The name for the column keeping the value itself.
- `column_sort`: The name of the sort column.
- `default_fc_parameters`: Mapping from feature calculator names to parameters.
- `kind_to_fc_parameters`: Mapping from kind names to feature calculator parameters.

**Return Value**: 
A pyspark dataframe with the columns column_id, "variable" and "value".

---
#### 52. `_into_subchunks()` Function - Split Time Series into Subwindows

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import _into_subchunks
```

**Functionality**:
Split the time series x into subwindows of length "subchunk_length", starting every "every_n".

**Function Signature**:
```python
def _into_subchunks(x, subchunk_length: int, every_n: int = 1) -> np.ndarray
```

**Parameter Description**:
- `x`: the time series to split
- `subchunk_length`: length of each subchunk
- `every_n`: step size between subchunks (default: 1)

**Return Value**:
Array of subchunks

---

#### 53. `set_property()` Function - Property Decorator

**Import Statement**:
```python
from tsfresh.feature_extraction.feature_calculators import set_property
```

**Functionality**:
This method returns a decorator that sets the property key of the function to value.

**Function Signature**:
```python
def set_property(key, value) -> callable
    def decorate_func(func):
```

**Parameter Description**:
- `key`: the property key to set
- `value`: the value to set for the property

**Return Value**:
A decorator function

---

#### 54. `has_duplicate_max()` Function - Check for Duplicate Maximum Values

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import has_duplicate_max
```

**Functionality**:
Checks if the maximum value of x is observed more than once.

**Function Signature**:
```python
def has_duplicate_max(x: np.ndarray) -> bool
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
True if the maximum value is observed more than once, False otherwise

---

#### 55. `has_duplicate_min()` Function - Check for Duplicate Minimum Values

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import has_duplicate_min
```

**Functionality**:
Checks if the minimal value of x is observed more than once.

**Function Signature**:
```python
def has_duplicate_min(x: np.ndarray) -> bool
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
True if the minimal value is observed more than once, False otherwise

---

#### 56. `has_duplicate()` Function - Check for Any Duplicate Values

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import has_duplicate
```

**Functionality**:
Checks if any value in x occurs more than once.

**Function Signature**:
```python
def has_duplicate(x: np.ndarray) -> bool
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
True if any value occurs more than once, False otherwise

---

#### 57. `sum_values()` Function - Sum of Time Series Values

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import sum_values
```

**Functionality**:
Calculates the sum over the time series values.

**Function Signature**:
```python
def sum_values(x: np.ndarray) -> float
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
The sum of all values in the time series

---

#### 58. `agg_autocorrelation()` Function - Aggregated Autocorrelation

**Import Statement**:
```python
import numpy as np
from statsmodels.tsa.stattools import acf
from tsfresh.feature_extraction.feature_calculators import agg_autocorrelation
```

**Functionality**:
Descriptive statistics on the autocorrelation of the time series. Calculates the value of an aggregation function (e.g. the variance or the mean) over the autocorrelation R(l) for different lags.

**Function Signature**:
```python
def agg_autocorrelation(x: np.ndarray, param: list) -> list
```

**Parameter Description**:
- `x`: the time series to calculate the feature of
- `param`: contains dictionaries {"f_agg": x, "maxlag", n} with x str, the name of a numpy function (e.g. "mean", "var", "std", "median"), its the name of the aggregator function that is applied to the autocorrelations. Further, n is an int and the maximal number of lags to consider.

**Return Value**:
List of tuples with feature names and values

---

#### 59. `partial_autocorrelation()` Function - Partial Autocorrelation

**Import Statement**:
```python
import numpy as np
from statsmodels.tsa.stattools import pacf
from tsfresh.feature_extraction.feature_calculators import partial_autocorrelation
```

**Functionality**:
Calculates the value of the partial autocorrelation function at the given lag. The lag k partial autocorrelation of a time series equals the partial correlation of x_t and x_{t-k}, adjusted for the intermediate variables.

**Function Signature**:
```python
def partial_autocorrelation(x: np.ndarray, param: list) -> list
```

**Parameter Description**:
- `x`: the time series to calculate the feature of
- `param`: contains dictionaries {"lag": val} with int val indicating the lag to be returned

**Return Value**:
List of tuples with feature names and values

---

#### 60. `augmented_dickey_fuller()` Function - Augmented Dickey-Fuller Test

**Import Statement**:
```python
import numpy as np
from statsmodels.tsa.stattools import adfuller
from tsfresh.feature_extraction.feature_calculators import augmented_dickey_fuller
```

**Functionality**:
The Augmented Dickey-Fuller test is a hypothesis test which checks whether a unit root is present in a time series sample. This feature calculator returns the value of the respective test statistic.

**Function Signature**:
```python
def augmented_dickey_fuller(x: np.ndarray, param: list) -> list
```

**Parameter Description**:
- `x`: the time series to calculate the feature of
- `param`: contains dictionaries {"attr": x, "autolag": y} with x str, either "teststat", "pvalue" or "usedlag" and with y str, either of "AIC", "BIC", "t-stats" or None

**Return Value**:
List of tuples with feature names and values

---

#### 61. `compute_adf()` Function - Compute ADF Test

**Import Statement**:
```python
import numpy as np
from statsmodels.tsa.stattools import adfuller
from tsfresh.feature_extraction.feature_calculators import augmented_dickey_fuller
```

**Functionality**:
Computes the Augmented Dickey-Fuller test statistic using lru_cache for performance optimization.

**Function Signature**:
```python
@functools.lru_cache()
def compute_adf(autolag) -> tuple
```

**Parameter Description**:
- `autolag`: the autolag parameter for the adfuller function

**Return Value**:
Tuple containing the test statistic, p-value, and used lag

---

#### 62. `abs_energy()` Function - Absolute Energy

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import abs_energy
```

**Functionality**:
Returns the absolute energy of the time series which is the sum over the squared values.

**Function Signature**:
```python
def abs_energy(x: np.ndarray) -> float
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
The absolute energy of the time series

---

#### 63. `mean_abs_change()` Function - Mean Absolute Change

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import mean_abs_change
```

**Functionality**:
Average over first differences. Returns the mean over the absolute differences between subsequent time series values.

**Function Signature**:
```python
def mean_abs_change(x: np.ndarray) -> float
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
The mean absolute change of the time series

---

#### 64. `mean_change()` Function - Mean Change

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import mean_change
```

**Functionality**:
Average over time series differences. Returns the mean over the differences between subsequent time series values.

**Function Signature**:
```python
def mean_change(x: np.ndarray) -> float
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
The mean change of the time series

---

#### 65. `mean_second_derivative_central()` Function - Mean Second Derivative

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import mean_second_derivative_central
```

**Functionality**:
Returns the mean value of a central approximation of the second derivative.

**Function Signature**:
```python
def mean_second_derivative_central(x: np.ndarray) -> float
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
The mean second derivative of the time series

---

#### 66. `variation_coefficient()` Function - Variation Coefficient

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import variation_coefficient
```

**Functionality**:
Returns the variation coefficient (standard error / mean, give relative value of variation around mean) of x.

**Function Signature**:
```python
def variation_coefficient(x: np.ndarray) -> float
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
The variation coefficient of the time series

---

#### 67. `root_mean_square()` Function - Root Mean Square

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import root_mean_square
```

**Functionality**:
Returns the root mean square (rms) of the time series.

**Function Signature**:
```python
def root_mean_square(x: np.ndarray) -> float
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
The root mean square of the time series

---

#### 68. `absolute_sum_of_changes()` Function - Absolute Sum of Changes

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import absolute_sum_of_changes
```

**Functionality**:
Returns the sum over the absolute value of consecutive changes in the series x.

**Function Signature**:
```python
def absolute_sum_of_changes(x: np.ndarray) -> float
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
The absolute sum of changes in the time series

---

#### 69. `longest_strike_below_mean()` Function - Longest Strike Below Mean

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import longest_strike_below_mean, _get_length_sequences_where
```

**Functionality**:
Returns the length of the longest consecutive subsequence in x that is smaller than the mean of x.

**Function Signature**:
```python
def longest_strike_below_mean(x: np.ndarray) -> float
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
The length of the longest consecutive subsequence below the mean

---

#### 70. `longest_strike_above_mean()` Function - Longest Strike Above Mean

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import longest_strike_above_mean, _get_length_sequences_where
```

**Functionality**:
Returns the length of the longest consecutive subsequence in x that is bigger than the mean of x.

**Function Signature**:
```python
def longest_strike_above_mean(x: np.ndarray) -> float
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
The length of the longest consecutive subsequence above the mean

---

#### 71. `count_above_mean()` Function - Count Above Mean

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import count_above_mean
```

**Functionality**:
Returns the number of values in x that are higher than the mean of x.

**Function Signature**:
```python
def count_above_mean(x: np.ndarray) -> float
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
The count of values above the mean

---

#### 72. `count_below_mean()` Function - Count Below Mean

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import count_below_mean
```

**Functionality**:
Returns the number of values in x that are lower than the mean of x.

**Function Signature**:
```python
def count_below_mean(x: np.ndarray) -> float
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
The count of values below the mean

---

#### 73. `last_location_of_maximum()` Function - Last Location of Maximum

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import last_location_of_maximum
```

**Functionality**:
Returns the relative last location of the maximum value of x. The position is calculated relatively to the length of x.

**Function Signature**:
```python
def last_location_of_maximum(x: np.ndarray) -> float
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
The relative last location of the maximum value

---

#### 74. `first_location_of_maximum()` Function - First Location of Maximum

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import first_location_of_maximum
```

**Functionality**:
Returns the first location of the maximum value of x. The position is calculated relatively to the length of x.

**Function Signature**:
```python
def first_location_of_maximum(x: np.ndarray) -> float
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
The relative first location of the maximum value

---

#### 75. `last_location_of_minimum()` Function - Last Location of Minimum

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import last_location_of_minimum
```

**Functionality**:
Returns the last location of the minimal value of x. The position is calculated relatively to the length of x.

**Function Signature**:
```python
def last_location_of_minimum(x: np.ndarray) -> float
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
The relative last location of the minimum value

---

#### 76. `first_location_of_minimum()` Function - First Location of Minimum

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import first_location_of_minimum
```

**Functionality**:
Returns the first location of the minimal value of x. The position is calculated relatively to the length of x.

**Function Signature**:
```python
def first_location_of_minimum(x: np.ndarray) -> float
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
The relative first location of the minimum value

---

#### 77. `percentage_of_reoccurring_values_to_all_values()` Function - Percentage of Reoccurring Values

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import percentage_of_reoccurring_values_to_all_values
```

**Functionality**:
Returns the percentage of values that are present in the time series more than once. This means the percentage is normalized to the number of unique values.

**Function Signature**:
```python
def percentage_of_reoccurring_values_to_all_values(x: np.ndarray) -> float
```

**Parameter Description**:
- `x`: the time series to calculate the feature of

**Return Value**:
The percentage of reoccurring values to all unique values

---

#### 78. `fft_coefficient()` Function - FFT Coefficient

**Import Statement**:
```python
import numpy as np
from tsfresh.feature_extraction.feature_calculators import fft_coefficient
```

**Functionality**:
Calculates the fourier coefficients of the one-dimensional discrete Fourier Transform for real input by fast fourier transformation algorithm. The resulting coefficients will be complex, this feature calculator can return the real part, the imaginary part, the absolute value and the angle in degrees.

**Function Signature**:
```python
def fft_coefficient(x: np.ndarray, param: list) -> list
```

**Parameter Description**:
- `x`: the time series to calculate the feature of
- `param`: contains dictionaries {"coeff": x, "attr": s} with x int and x >= 0, s str and in ["real", "imag", "abs", "angle"]

**Return Value**:
Iterator of tuples with feature names and values

---
#### 79. `complex_agg()` Function - Aggregation of Complex Numbers

**Import Statement**: 
```python 
import numpy as np
from typing import Literal
from tsfresh.feature_extraction.feature_calculators import complex_agg
```

**Functionality**: 
Applies different aggregation functions to complex numbers, returning either the real part, imaginary part, absolute value, or angle of the complex number.

**Function Signature**: 
```python 
def complex_agg(
    x, agg: Literal["real", "imag", "angle", "abs"]
)
```

**Parameter Description**: 
- `x`: the complex number to calculate the feature of
- `agg`: the type of aggregation to perform, must be "real", "imag", "angle" or "abs"

**Return Value**: 
A float representing the requested aggregation of the complex number.

---

#### 80. `fft_aggregated()` Function - Spectral Moments of Fourier Transform

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import fft_aggregated
```

**Functionality**: 
Returns the spectral centroid (mean), variance, skew, and kurtosis of the absolute fourier transform spectrum.

**Function Signature**: 
```python 
def fft_aggregated(
    x, param
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `param`: contains dictionaries {"aggtype": s} where s str and in ["centroid", "variance", "skew", "kurtosis"]

**Return Value**: 
An Iterator[Tuple[str, float]] with the different feature values.

---

#### 81. `get_moment()` Function - Statistical Moments Calculation

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import get_moment
```

**Functionality**: 
Returns the (non centered) moment of the distribution y: E[y**moment] = \\sum_i[index(y_i)^moment * y_i] / \\sum_i[y_i]

**Function Signature**: 
```python 
def get_moment(
    y, moment
)
```

**Parameter Description**: 
- `y`: the discrete distribution from which one wants to calculate the moment (pandas.Series or np.array)
- `moment`: the moment one wants to calculate (choose 1,2,3, ... ) (int)

**Return Value**: 
A float representing the moment requested.

---

#### 82. `get_centroid()` Function - Distribution Centroid Calculation

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import get_centroid
```

**Functionality**: 
Calculates the centroid of a distribution, which is equivalent to the distribution mean (first moment).

**Function Signature**: 
```python 
def get_centroid(
    y
)
```

**Parameter Description**: 
- `y`: the discrete distribution from which one wants to calculate the centroid (pandas.Series or np.array)

**Return Value**: 
A float representing the centroid of distribution y.

---

#### 83. `get_variance()` Function - Distribution Variance Calculation

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import get_variance
```

**Functionality**: 
Calculates the variance of a distribution.

**Function Signature**: 
```python 
def get_variance(
    y
)
```

**Parameter Description**: 
- `y`: the discrete distribution from which one wants to calculate the variance (pandas.Series or np.array)

**Return Value**: 
A float representing the variance of distribution y.

---

#### 84. `get_skew()` Function - Distribution Skewness Calculation

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import get_skew
```

**Functionality**: 
Calculates the skew as the third standardized moment. In the limit of a dirac delta, skew should be 0 and variance 0. However, in the discrete limit, the skew blows up as variance --> 0, hence return nan when variance is smaller than a resolution of 0.5.

**Function Signature**: 
```python 
def get_skew(
    y
)
```

**Parameter Description**: 
- `y`: the discrete distribution from which one wants to calculate the skew (pandas.Series or np.array)

**Return Value**: 
A float representing the skew of distribution y.

---

#### 85. `get_kurtosis()` Function - Distribution Kurtosis Calculation

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import get_kurtosis
```

**Functionality**: 
Calculates the kurtosis as the fourth standardized moment. In the limit of a dirac delta, kurtosis should be 3 and variance 0. However, in the discrete limit, the kurtosis blows up as variance --> 0, hence return nan when variance is smaller than a resolution of 0.5.

**Function Signature**: 
```python 
def get_kurtosis(
    y
)
```

**Parameter Description**: 
- `y`: the discrete distribution from which one wants to calculate the kurtosis (pandas.Series or np.array)

**Return Value**: 
A float representing the kurtosis of distribution y.

---

#### 86. `_ricker()` Function - Ricker Wavelet Implementation

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import _ricker
```

**Functionality**: 
Custom implementation of the ricker wavelet, copied from scipy as scipy dropped it.

**Function Signature**: 
```python 
def _ricker(
    points, a
)
```

**Parameter Description**: 
- `points`: the number of points in the wavelet
- `a`: the width parameter of the wavelet function

**Return Value**: 
A numpy array representing the ricker wavelet.

---

#### 87. `number_cwt_peaks()` Function - Continuous Wavelet Transform Peaks

**Import Statement**: 
```python 
import numpy as np
from scipy.signal import find_peaks_cwt
from tsfresh.feature_extraction.feature_calculators import number_cwt_peaks, _ricker
```

**Functionality**: 
Counts the number of different peaks in a time series by smoothing x with a ricker wavelet for widths ranging from 1 to n.

**Function Signature**: 
```python 
def number_cwt_peaks(
    x, n
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `n`: maximum width to consider (int)

**Return Value**: 
An int representing the number of peaks.

---

#### 88. `linear_trend()` Function - Linear Least-Squares Regression

**Import Statement**: 
```python 
import numpy as np
from scipy.stats import linregress
from tsfresh.feature_extraction.feature_calculators import linear_trend
```

**Functionality**: 
Calculate a linear least-squares regression for the values of the time series versus the sequence from 0 to length of the time series minus one. This feature assumes the signal to be uniformly sampled.

**Function Signature**: 
```python 
def linear_trend(
    x, param
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `param`: contains dictionaries {"attr": x} with x an string, the attribute name of the regression model (list)

**Return Value**: 
A List[Tuple[str, float]] with the different feature values.

---

#### 89. `cwt_coefficients()` Function - Continuous Wavelet Transform Coefficients

**Import Statement**: 
```python 
import numpy as np
import pywt
from tsfresh.feature_extraction.feature_calculators import cwt_coefficients
```

**Functionality**: 
Calculates a Continuous wavelet transform for the Ricker wavelet, also known as the "Mexican hat wavelet".

**Function Signature**: 
```python 
def cwt_coefficients(
    x, param
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `param`: contains dictionaries {"widths":x, "coeff": y, "w": z} with x array of int and y,z int (list)

**Return Value**: 
An Iterator[Tuple[str, float]] with the different feature values.

---

#### 90. `spkt_welch_density()` Function - Power Spectral Density Estimation

**Import Statement**: 
```python 
import numpy as np
from scipy.signal import welch
from tsfresh.feature_extraction.feature_calculators import spkt_welch_density
```

**Functionality**: 
Estimates the cross power spectral density of the time series x at different frequencies by shifting from the time domain to the frequency domain.

**Function Signature**: 
```python 
def spkt_welch_density(
    x, param
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `param`: contains dictionaries {"coeff": x} with x int (list)

**Return Value**: 
An Iterator[Tuple[str, float]] with the different feature values.

---

#### 91. `ar_coefficient()` Function - Autoregressive Process Coefficients

**Import Statement**: 
```python 
import numpy as np
from statsmodels.tsa.ar_model import AutoReg
from tsfresh.feature_extraction.feature_calculators import ar_coefficient
```

**Functionality**: 
Fits the unconditional maximum likelihood of an autoregressive AR(k) process and returns specified coefficients.

**Function Signature**: 
```python 
def ar_coefficient(
    x, param
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `param`: contains dictionaries {"coeff": x, "k": y} with x,y int (list)

**Return Value**: 
A List[Tuple[str, float]] with the different feature values.

---

#### 92. `change_quantiles()` Function - Quantile-Based Change Statistics

**Import Statement**: 
```python 
import numpy as np
import pandas as pd
from tsfresh.feature_extraction.feature_calculators import change_quantiles
```

**Functionality**: 
First fixes a corridor given by the quantiles ql and qh of the distribution of x. Then calculates the average, absolute value of consecutive changes of the series x inside this corridor.

**Function Signature**: 
```python 
def change_quantiles(
    x, ql, qh, isabs, f_agg
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `ql`: the lower quantile of the corridor (float)
- `qh`: the higher quantile of the corridor (float)
- `isabs`: should the absolute differences be taken? (bool)
- `f_agg`: the aggregator function that is applied to the differences in the bin (str, name of a numpy function (e.g. mean, var, std, median))

**Return Value**: 
A float representing the value of this feature.

---

#### 93. `time_reversal_asymmetry_statistic()` Function - Time Reversal Asymmetry

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import time_reversal_asymmetry_statistic, _roll
```

**Functionality**: 
Returns the time reversal asymmetry statistic, which is a measure of the asymmetry of a time series under time reversal.

**Function Signature**: 
```python 
def time_reversal_asymmetry_statistic(
    x, lag
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `lag`: the lag that should be used in the calculation of the feature (int)

**Return Value**: 
A float representing the value of this feature.

---

#### 94. `c3()` Function - Non-Linearity Measurement

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import c3, _roll
```

**Functionality**: 
Uses c3 statistics to measure non linearity in the time series by calculating the expectation of L^2(X) · L(X) · X.

**Function Signature**: 
```python 
def c3(
    x, lag
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `lag`: the lag that should be used in the calculation of the feature (int)

**Return Value**: 
A float representing the value of this feature.

---

#### 95. `mean_n_absolute_max()` Function - Mean of Absolute Maximum Values

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import mean_n_absolute_max
```

**Functionality**: 
Calculates the arithmetic mean of the n absolute maximum values of the time series.

**Function Signature**: 
```python 
def mean_n_absolute_max(
    x, number_of_maxima
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `number_of_maxima`: the number of maxima, which should be considered (int)

**Return Value**: 
A float representing the value of this feature.

---

#### 96. `binned_entropy()` Function - Binned Entropy Calculation

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import binned_entropy
```

**Functionality**: 
Bins the values of x into max_bins equidistant bins and calculates the entropy of the bin distribution.

**Function Signature**: 
```python 
def binned_entropy(
    x, max_bins
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `max_bins`: the maximal number of bins (int)

**Return Value**: 
A float representing the value of this feature.

---

#### 97. `sample_entropy()` Function - Sample Entropy

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import sample_entropy, _into_subchunks
```

**Functionality**: 
Calculate and return sample entropy of x, which is a measure of the complexity of the time series.

**Function Signature**: 
```python 
def sample_entropy(
    x
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)

**Return Value**: 
A float representing the value of this feature.

---

#### 98. `approximate_entropy()` Function - Approximate Entropy

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import approximate_entropy
```

**Functionality**: 
Implements a vectorized Approximate entropy algorithm, which is a technique used to quantify the amount of regularity and the unpredictability of fluctuations over time-series data.

**Function Signature**: 
```python 
def approximate_entropy(
    x, m, r
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `m`: Length of compared run of data (int)
- `r`: Filtering level, must be positive (float)

**Return Value**: 
A float representing the approximate entropy.

---

#### 99. `_phi()` Function - Helper Function for Approximate Entropy

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import _phi
```

**Functionality**: 
Helper function for calculating approximate entropy that computes the phi value for a given embedding dimension.

**Function Signature**: 
```python 
def _phi(
    m
)
```

**Parameter Description**: 
- `m`: the embedding dimension

**Return Value**: 
A float representing the phi value.

---

#### 100. `fourier_entropy()` Function - Fourier Transform Entropy

**Import Statement**: 
```python 
import numpy as np
from scipy.signal import welch
from tsfresh.feature_extraction.feature_calculators import fourier_entropy, binned_entropy
```

**Functionality**: 
Calculate the binned entropy of the power spectral density of the time series (using the welch method).

**Function Signature**: 
```python 
def fourier_entropy(
    x, bins
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `bins`: the number of bins to use for entropy calculation (int)

**Return Value**: 
A float representing the value of this feature.

---

#### 101. `lempel_ziv_complexity()` Function - Lempel-Ziv Complexity

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import lempel_ziv_complexity
```

**Functionality**: 
Calculate a complexity estimate based on the Lempel-Ziv compression algorithm by counting the number of dictionary entries needed to encode the time series.

**Function Signature**: 
```python 
def lempel_ziv_complexity(
    x, bins
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `bins`: the number of bins to use for discretization (int)

**Return Value**: 
A float representing the value of this feature.

---

#### 102. `permutation_entropy()` Function - Permutation Entropy

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import permutation_entropy, _into_subchunks
```

**Functionality**: 
Calculate the permutation entropy, which captures the ordinal ranking of the data in sub-windows.

**Function Signature**: 
```python 
def permutation_entropy(
    x, tau, dimension
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `tau`: the time delay for creating sub-windows (int)
- `dimension`: the length of compared run of data (int)

**Return Value**: 
A float representing the permutation entropy.

---

#### 103. `number_crossing_m()` Function - Threshold Crossings Count

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import number_crossing_m
```

**Functionality**: 
Calculates the number of crossings of x on m. A crossing is defined as two sequential values where the first value is lower than m and the next is greater, or vice-versa.

**Function Signature**: 
```python 
def number_crossing_m(
    x, m
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `m`: the threshold for the crossing (float)

**Return Value**: 
An int representing the value of this feature.

---

#### 104. `absolute_maximum()` Function - Absolute Maximum Value

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import absolute_maximum
```

**Functionality**: 
Calculates the highest absolute value of the time series x.

**Function Signature**: 
```python 
def absolute_maximum(
    x
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)

**Return Value**: 
A float representing the value of this feature.

---

#### 105. `value_count()` Function - Value Occurrence Count

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import value_count
```

**Functionality**: 
Count occurrences of `value` in time series x.

**Function Signature**: 
```python 
def value_count(
    x, value
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `value`: the value to be counted (int or float)

**Return Value**: 
An int representing the count.

---

#### 106. `range_count()` Function - Range-Based Count

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import range_count
```

**Functionality**: 
Count observed values within the interval [min, max).

**Function Signature**: 
```python 
def range_count(
    x, min, max
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `min`: the inclusive lower bound of the range (int or float)
- `max`: the exclusive upper bound of the range (int or float)

**Return Value**: 
An int representing the count of values within the range.

---

#### 107. `agg_linear_trend()` Function - Aggregated Linear Trend

**Import Statement**: 
```python 
import numpy as np
from scipy.stats import linregress
from tsfresh.feature_extraction.feature_calculators import agg_linear_trend, _aggregate_on_chunks
```

**Functionality**: 
Calculates a linear least-squares regression for values of the time series that were aggregated over chunks versus the sequence from 0 up to the number of chunks minus one.

**Function Signature**: 
```python 
def agg_linear_trend(
    x, param
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `param`: contains dictionaries {"attr": x, "chunk_len": l, "f_agg": f} with x, f an string and l an int (list)

**Return Value**: 
An Iterator[Tuple[str, float]] with the different feature values.

---

#### 108. `linear_trend_timewise()` Function - Time-Aware Linear Trend

**Import Statement**: 
```python 
import numpy as np
import pandas as pd
from scipy.stats import linregress
from tsfresh.feature_extraction.feature_calculators import linear_trend_timewise
```

**Functionality**: 
Calculate a linear least-squares regression for the values of the time series versus the sequence from 0 to length of the time series minus one. This feature uses the index of the time series to fit the model, which must be of a datetime dtype.

**Function Signature**: 
```python 
def linear_trend_timewise(
    x, param
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of. The index must be datetime. (pandas.Series)
- `param`: contains dictionaries {"attr": x} with x an string, the attribute name of the regression model (list)

**Return Value**: 
A List[Tuple[str, float]] with the different feature values.

---

#### 109. `count_above()` Function - Count Above Threshold

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import count_above
```

**Functionality**: 
Returns the percentage of values in x that are higher than t.

**Function Signature**: 
```python 
def count_above(
    x, t
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (pandas.Series)
- `t`: value used as threshold (float)

**Return Value**: 
A float representing the value of this feature.

---

#### 110. `count_below()` Function - Count Below Threshold

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import count_below
```

**Functionality**: 
Returns the percentage of values in x that are lower than t.

**Function Signature**: 
```python 
def count_below(
    x, t
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (pandas.Series)
- `t`: value used as threshold (float)

**Return Value**: 
A float representing the value of this feature.

---

#### 111. `benford_correlation()` Function - Benford's Law Correlation

**Import Statement**: 
```python 
import numpy as np
from tsfresh.feature_extraction.feature_calculators import benford_correlation
```

**Functionality**: 
Useful for anomaly detection applications. Returns the correlation from first digit distribution when compared to the Newcomb-Benford's Law distribution.

**Function Signature**: 
```python 
def benford_correlation(
    x
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)

**Return Value**: 
A float representing the value of this feature.

---

#### 112. `matrix_profile()` Function - Matrix Profile Analysis

**Import Statement**: 
```python 
import numpy as np
import matrixprofile as mp
from tsfresh.feature_extraction.feature_calculators import matrix_profile
```

**Functionality**: 
Calculates the 1-D Matrix Profile and returns Tukey's Five Number Set plus the mean of that Matrix Profile.

**Function Signature**: 
```python 
def matrix_profile(
    x, param
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `param`: contains dictionaries {"sample_pct": x, "threshold": y, "feature": z} with sample_pct and threshold being parameters of the matrixprofile package and feature being one of "min", "max", "mean", "median", "25", "75" (list)

**Return Value**: 
A List[Tuple[str, float]] with the different feature values.

---

#### 113. `query_similarity_count()` Function - Subsequence Similarity Count

**Import Statement**: 
```python 
import numpy as np
import stumpy
from tsfresh.feature_extraction.feature_calculators import query_similarity_count
```

**Functionality**: 
This feature calculator accepts an input query subsequence parameter, compares the query (under z-normalized Euclidean distance) to all subsequences within the time series, and returns a count of the number of times the query was found in the time series.

**Function Signature**: 
```python 
def query_similarity_count(
    x, param
)
```

**Parameter Description**: 
- `x`: the time series to calculate the feature of (numpy.ndarray)
- `param`: contains dictionaries {"query": Q, "threshold": thr, "normalize": norm} with `Q` (numpy.ndarray), the query subsequence to compare the time series against. If `Q` is omitted then a value of zero is returned. Additionally, `thr` (float), the maximum z-normalized Euclidean distance threshold for which to increment the query similarity count. If `thr` is omitted then a default threshold of `thr=0.0` is used, which corresponds to finding exact matches to `Q`. Finally, for non-normalized (i.e., without z-normalization) Euclidean set `norm` (bool) to `False. (list[dict])

**Return Value**: 
A List[Tuple[str, int | np.nan]] with the different feature values.

---

### Detailed Description of Configuration Classes

#### 1. `MinimalFCParameters`
**Functionality**:
Configuration for the minimal feature set, containing only commonly used basic features, suitable for quick experiments.

**Usage**:
```python
from tsfresh.feature_extraction import MinimalFCParameters
params = MinimalFCParameters()
```

---

#### 2. `ComprehensiveFCParameters`
**Functionality**:
Configuration for the full feature set, containing all built-in features, suitable for comprehensive feature extraction.

**Usage**:
```python
from tsfresh.feature_extraction import ComprehensiveFCParameters
params = ComprehensiveFCParameters()
```

---

#### 3. `EfficientFCParameters`
**Functionality**:
Configuration for the efficient feature set, balancing speed and information content.

**Usage**:
```python
from tsfresh.feature_extraction import EfficientFCParameters
params = EfficientFCParameters()
```

---

#### 4. `IndexBasedFCParameters`
**Functionality**:
Configuration for index-based feature calculation parameters, used when features are calculated based on time series indices rather than actual time values.

**Usage**:
```python
from tsfresh.feature_extraction import IndexBasedFCParameters
params = IndexBasedFCParameters()
```

---

#### 5. `TimeBasedFCParameters`
**Functionality**:
Configuration for time-based feature calculation parameters, used when features are calculated based on actual time values with proper temporal relationships.

**Usage**:
```python
from tsfresh.feature_extraction import TimeBasedFCParameters
params = TimeBasedFCParameters()
```

---

#### 4. `PickableSettings`
**Functionality**:
Serializable feature extraction parameter configuration, supporting customization and persistence.

**Usage**:
```python
from tsfresh.feature_extraction.settings import PickableSettings
settings = PickableSettings({'mean': None, 'std': None})
```

---

#### 5. `ApplyDistributor`, `ClusterDaskDistributor`, `LocalDaskDistributor`, `MapDistributor`, `MultiprocessingDistributor`, `IterableDistributorBaseClass`
**Functionality**:
Distributors for distributed/parallel feature extraction, supporting multiple backends such as local multi-process, Dask cluster, Map, and Dask apply operations.

**Classes Description**:
- `ApplyDistributor`: Uses Dask's apply function for distributed computation
- `ClusterDaskDistributor`: Connects to existing Dask cluster for distributed processing
- `LocalDaskDistributor`: Creates local Dask cluster for parallel processing
- `MapDistributor`: Uses simple map function for parallel processing
- `MultiprocessingDistributor`: Uses multiprocessing for parallel execution
- `IterableDistributorBaseClass`: Base class for all iterable distributors

**Usage**:
```python
from tsfresh.utilities.distribution import (
    ApplyDistributor, 
    LocalDaskDistributor, 
    MapDistributor
)
distributor = LocalDaskDistributor(n_jobs=4)
apply_distributor = ApplyDistributor(meta=None)
```

---

## Detailed Implementation Nodes of Functions

### Node 1: Time Series Feature Extraction (Feature Extraction)
**Function Description**:
- Automatically extracts statistical features (such as maximum, minimum, mean, energy, linear trend, etc.) in batches from various formats of time series data, supporting multiple parameter configurations and custom feature functions.

**Overview of Core Algorithms**:
- Data grouping and sorting.
- Batch application of feature calculators (such as maximum, mean, energy, etc.).
- Support for custom feature functions.
- Parallel and distributed feature extraction.

**Input-Output Examples**:
```Python
import numpy as np
import pandas as pd
from tsfresh import extract_features
from tsfresh.feature_extraction import MinimalFCParameters

def test_feature_extraction():
    # 1. Normal multiple groups
    df = pd.DataFrame({'id': [1, 1, 2, 2], 'time': [1, 2, 1, 2], 'value': [10, 20, 30, 40]})
    X = extract_features(df, column_id='id', column_sort='time', default_fc_parameters=MinimalFCParameters())
    assert np.isclose(X.loc[1, 'value__mean'], 15.0)
    assert np.isclose(X.loc[2, 'value__maximum'], 40.0)
    # 2. Single group, single point
    df = pd.DataFrame({'id': [1], 'time': [1], 'value': [10]})
    X = extract_features(df, column_id='id', column_sort='time', default_fc_parameters=MinimalFCParameters())
    assert np.isclose(X.loc[1, 'value__mean'], 10.0)
    # 3. Missing values
    df = pd.DataFrame({'id': [1, 1], 'time': [1, 2], 'value': [np.nan, 20]})
    X = extract_features(df, column_id='id', column_sort='time', default_fc_parameters=MinimalFCParameters())
    assert 'value__mean' in X.columns
    # 4. Extreme values
    df = pd.DataFrame({'id': [1, 1], 'time': [1, 2], 'value': [1e10, -1e10]})
    X = extract_features(df, column_id='id', column_sort='time', default_fc_parameters=MinimalFCParameters())
    assert 'value__mean' in X.columns
    # 5. Multiple columns
    df = pd.DataFrame({'id': [1, 1], 'time': [1, 2], 'value1': [1, 2], 'value2': [3, 4]})
    X = extract_features(df, column_id='id', column_sort='time', default_fc_parameters=MinimalFCParameters())
    assert 'value1__mean' in X.columns and 'value2__mean' in X.columns
    # 6. Parallel consistency
    X1 = extract_features(df, column_id='id', column_sort='time', default_fc_parameters=MinimalFCParameters(), n_jobs=1)
    X2 = extract_features(df, column_id='id', column_sort='time', default_fc_parameters=MinimalFCParameters(), n_jobs=2)
    assert X1.equals(X2)
    # 7. Custom features
    def custom_func(x): return x.max() - x.min()
    from tsfresh.feature_extraction.settings import PickableSettings
    settings = PickableSettings({'mean': None, custom_func: None})
    X = extract_features(df, column_id='id', column_sort='time', default_fc_parameters=settings)
    assert any('custom_func' in c for c in X.columns)

test_feature_extraction()
```

### Node 2: Relevant Feature Extraction and Selection (Relevant Feature Extraction & Selection)
**Function Description**:
- Automatically extracts features that are most relevant to the target variable, supporting various task types such as binary classification, multi-class classification, and regression, and automatically filters out irrelevant features.

**Overview of Core Algorithms**:
- First, extracts all features in batches.
- Conducts feature significance tests (such as FDR control, p-value calculation).
- Selects relevant features.
- Supports multi-task/multi-label scenarios.

**Input-Output Examples**:
```Python
import pandas as pd
import numpy as np
from tsfresh import extract_relevant_features

def test_relevant_feature_extraction():
    # 1. Binary classification
    df = pd.DataFrame({'id': [1, 1, 2, 2], 'time': [1, 2, 1, 2], 'value': [10, 20, 30, 40]})
    y = pd.Series([0, 1], index=[1, 2])
    X = extract_relevant_features(df, y, column_id='id', column_sort='time', column_value='value')
    assert X.shape[0] == 2
    # 2. Multi-class classification
    y = pd.Series([0, 1], index=[1, 2])
    X = extract_relevant_features(df, y, column_id='id', column_sort='time', column_value='value')
    assert X.shape[0] == 2
    # 3. Continuous
    y = pd.Series([0.1, 0.9], index=[1, 2])
    X = extract_relevant_features(df, y, column_id='id', column_sort='time', column_value='value')
    assert X.shape[0] == 2
    # 4. Index mismatch
    y = pd.Series([0, 1], index=[3, 4])
    try:
        extract_relevant_features(df, y, column_id='id', column_sort='time', column_value='value')
        assert False
    except ValueError:
        pass
    # 5. Target all constant
    y = pd.Series([1, 1], index=[1, 2])
    try:
        extract_relevant_features(df, y, column_id='id', column_sort='time', column_value='value')
        assert False
    except AssertionError:
        pass
    # 6. Target as array
    y = np.array([0, 1])
    try:
        extract_relevant_features(df, y, column_id='id', column_sort='time', column_value='value')
        assert False
    except AssertionError:
        pass
    # 7. Multiple input feature tables
    df_dict = {'a': df, 'b': df}
    y = pd.Series([0, 1], index=[1, 2])
    try:
        extract_relevant_features(df_dict, y, column_id='id', column_sort='time', column_value='value')
        assert False
    except ValueError:
        pass

test_relevant_feature_extraction()
```

### Node 3: Unit Testing of Feature Calculators (Feature Calculators)
**Function Description**:
- Conducts unit tests on each built-in feature calculator (such as mean, variance, skewness, kurtosis, Fourier coefficients, etc.) for input-output correctness, boundary values, abnormal values, NaN values, etc.

**Overview of Core Algorithms**:
- Designs various inputs (empty, all the same, extreme, NaN, normal, etc.) for each feature function.
- Verifies the output type, numerical value, and exception handling.

**Input-Output Examples**:
```Python
from tsfresh.feature_extraction.feature_calculators import mean, variance
import numpy as np
import pandas as pd

def test_feature_calculators():
    # 1. Empty input
    assert np.isnan(mean([]))
    # 2. All the same
    assert mean([1, 1, 1]) == 1
    # 3. Extreme
    assert mean([1e10, -1e10]) == 0
    # 4. NaN
    assert np.isnan(mean([np.nan]))
    # 5. Normal
    assert mean([1, 2, 3]) == 2
    # 6. Multiple types
    assert mean(np.array([1, 2, 3])) == 2
    assert mean(pd.Series([1, 2, 3])) == 2
    # Variance
    assert variance([1, 2, 3]) == 1
    assert np.isnan(variance([]))

test_feature_calculators()
```

### Node 4: Feature Significance and Selection (Feature Significance & Selection)
**Function Description**:
- Conducts statistical tests on the relevance between features and the target variable, and automatically selects significant features, supporting various tasks such as binary classification, multi-class classification, and regression.

**Overview of Core Algorithms**:
- Relevance tests (such as p-value, FDR control).
- Support for multi-task/multi-label scenarios.
- Verification of boundary conditions and abnormal inputs.

**Input-Output Examples**:
```Python
import numpy as np
import pandas as pd
from tsfresh.feature_selection.selection import select_features

def test_feature_selection():
    # 1. Binary classification
    X = pd.DataFrame({'f1': [1, 2, 3], 'f2': [4, 5, 6]})
    y = pd.Series([0, 1, 0])
    X_relevant = select_features(X, y)
    assert set(X_relevant.columns).issubset({'f1', 'f2'})
    # 2. Multi-class classification
    X = pd.DataFrame({'f1': [1, 2, 3, 4], 'f2': [4, 5, 6, 7]})
    y = pd.Series([0, 1, 2, 1])
    X_relevant = select_features(X, y)
    assert set(X_relevant.columns).issubset({'f1', 'f2'})
    # 3. Continuous
    y = pd.Series([0.1, 0.9, 0.2, 0.8])
    X_relevant = select_features(X, y)
    assert set(X_relevant.columns).issubset({'f1', 'f2'})
    # 4. Index mismatch
    y = pd.Series([0, 1, 2, 3], index=[10, 11, 12, 13])
    try:
        select_features(X, y)
        assert False
    except ValueError:
        pass
    # 5. Target all constant
    y = pd.Series([1, 1, 1, 1])
    try:
        select_features(X, y)
        assert False
    except AssertionError:
        pass
    # 6. Target as array
    y = np.array([0, 1, 2, 3])
    try:
        select_features(X, y)
        assert False
    except AssertionError:
        pass
    # 7. Multiple input feature tables
    # tsfresh does not support multiple input feature tables, skipped
    # 8. Multi-task/multi-label
    # See relevant tests in transformers/FeatureSelector

test_feature_selection()
```

### Node 5: Feature Selector (FeatureSelector Transformer)
**Function Description**:
- As an sklearn-style feature selector, it supports the fit/transform interface, automatically selects relevant features, and supports multi-class classification, multi-label, and output of feature importance.

**Overview of Core Algorithms**:
- Automatically selects relevant features during the training phase.
- Only retains relevant features during the transform phase.
- Supports output of feature importance and p-values.
- Supports multi-task/multi-label scenarios.

**Input-Output Examples**:
```Python
import numpy as np
import pandas as pd
from tsfresh.transformers.feature_selector import FeatureSelector

def test_feature_selector():
    # 1. Transform without fitting first
    selector = FeatureSelector()
    try:
        selector.transform(pd.DataFrame())
        assert False
    except RuntimeError:
        pass
    # 2. Binary classification
    y = pd.Series([0, 1, 0, 1])
    X = pd.DataFrame({'f1': y, 'f2': np.random.randn(4)})
    selector.fit(X, y)
    X_selected = selector.transform(X)
    assert 'f1' in X_selected.columns
    # 3. All irrelevant
    y = pd.Series([0, 1, 0, 1])
    X = pd.DataFrame({'f1': np.random.randn(4)})
    selector.fit(X, y)
    X_selected = selector.transform(X)
    assert X_selected.shape[1] == 0
    # 4. Numpy array
    y = np.array([0, 1, 0, 1])
    X = np.array([[1, 2], [2, 3], [3, 4], [4, 5]])
    selector.fit(X, y)
    X_selected = selector.transform(X)
    assert X_selected.shape[1] == 1
    # 5. Feature importance
    y = pd.Series([0, 1, 0, 1])
    X = pd.DataFrame({'f1': y, 'f2': np.random.randn(4)})
    selector.fit(X, y)
    assert selector.feature_importances_ is not None
    assert selector.p_values is not None

test_feature_selector()
```

### Node 6: Feature Augmentation Transformer (FeatureAugmenter Transformer)
**Function Description**:
- As an sklearn-style feature augmentation transformer, it supports the fit/transform interface, converts time series data into a feature matrix, and supports various data formats and parameter configurations.

**Overview of Core Algorithms**:
- Sets the time series container and feature extraction parameters during the training phase.
- Extracts features in batches during the transform phase.
- Supports various data formats (DataFrame, dictionary, etc.).
- Automatically handles missing values and abnormal values.

**Input-Output Examples**:
```Python
import numpy as np
import pandas as pd
from tsfresh.transformers.feature_augmenter import FeatureAugmenter
from tsfresh.feature_extraction import MinimalFCParameters

def test_feature_augmenter():
    # 1. Time series container not set
    augmenter = FeatureAugmenter()
    try:
        augmenter.transform(pd.DataFrame())
        assert False
    except RuntimeError:
        pass
    # 2. Normal use
    df = pd.DataFrame({'id': [1, 1, 2, 2], 'time': [1, 2, 1, 2], 'value': [10, 20, 30, 40]})
    X = pd.DataFrame({'id': [1, 2]})
    augmenter = FeatureAugmenter(
        column_id='id',
        column_sort='time',
        default_fc_parameters=MinimalFCParameters()
    )
    augmenter.set_timeseries_container(df)
    X_augmented = augmenter.fit_transform(X)
    assert 'value__mean' in X_augmented.columns
    # 3. Dictionary format data
    df_dict = {'temp': df, 'pressure': df}
    augmenter = FeatureAugmenter(
        column_id='id',
        column_sort='time',
        default_fc_parameters=MinimalFCParameters()
    )
    augmenter.set_timeseries_container(df_dict)
    X_augmented = augmenter.fit_transform(X)
    assert 'temp__value__mean' in X_augmented.columns
    # 4. Custom parameters
    settings = MinimalFCParameters()
    settings['mean'] = None
    settings['std'] = None
    augmenter = FeatureAugmenter(
        column_id='id',
        column_sort='time',
        default_fc_parameters=settings
    )
    augmenter.set_timeseries_container(df)
    X_augmented = augmenter.fit_transform(X)
    assert 'value__mean' in X_augmented.columns
    assert 'value__std' in X_augmented.columns

test_feature_augmenter()
```

### Node 7: Relevant Feature Augmentation Transformer (RelevantFeatureAugmenter Transformer)
**Function Description**:
- As an sklearn-style transformer that combines feature extraction and feature selection, it automatically extracts relevant features and integrates them into the machine learning pipeline, supporting various task types.

**Overview of Core Algorithms**:
- Extracts features and selects relevant features during the training phase.
- Only uses relevant features during the transform phase.
- Supports multiple statistical test methods.
- Automatically handles multi-class and multi-label tasks.

**Input-Output Examples**:
```Python
import numpy as np
import pandas as pd
from tsfresh.transformers.relevant_feature_augmenter import RelevantFeatureAugmenter

def test_relevant_feature_augmenter():
    # 1. Binary classification task
    df = pd.DataFrame({'id': [1, 1, 2, 2], 'time': [1, 2, 1, 2], 'value': [10, 20, 30, 40]})
    X = pd.DataFrame({'id': [1, 2]})
    y = pd.Series([0, 1], index=[1, 2])
    augmenter = RelevantFeatureAugmenter(
        column_id='id',
        column_sort='time',
        fdr_level=0.05
    )
    augmenter.set_timeseries_container(df)
    X_augmented = augmenter.fit_transform(X, y)
    assert X_augmented.shape[1] >= 0  # There may be no relevant features
    # 2. Multi-class classification task
    y = pd.Series([0, 1, 2], index=[1, 2, 3])
    df = pd.DataFrame({'id': [1, 1, 2, 2, 3, 3], 'time': [1, 2, 1, 2, 1, 2], 'value': [10, 20, 30, 40, 50, 60]})
    X = pd.DataFrame({'id': [1, 2, 3]})
    augmenter = RelevantFeatureAugmenter(
        column_id='id',
        column_sort='time',
        fdr_level=0.05
    )
    augmenter.set_timeseries_container(df)
    X_augmented = augmenter.fit_transform(X, y)
    # 3. Regression task
    y = pd.Series([0.1, 0.9], index=[1, 2])
    augmenter = RelevantFeatureAugmenter(
        column_id='id',
        column_sort='time',
        fdr_level=0.05
    )
    augmenter.set_timeseries_container(df)
    X_augmented = augmenter.fit_transform(X, y)
    # 4. Custom statistical test
    augmenter = RelevantFeatureAugmenter(
        column_id='id',
        column_sort='time',
        fdr_level=0.05,
        test_for_binary_target_real_feature='mann'
    )
    augmenter.set_timeseries_container(df)
    X_augmented = augmenter.fit_transform(X, y)

test_relevant_feature_augmenter()
```

### Node 8: Per-Column Missing Value Filling Transformer (PerColumnImputer Transformer)
**Function Description**:
- As an sklearn-style transformer, it fills missing values in the feature matrix column by column, supporting multiple filling strategies and custom filling functions.

**Overview of Core Algorithms**:
- Learns the filling strategy for each column during the training phase.
- Applies the filling strategy during the transform phase.
- Supports multiple filling methods (mean, median, constant, etc.).
- Automatically handles numerical and categorical features.

**Input-Output Examples**:
```Python
import numpy as np
import pandas as pd
from tsfresh.transformers.per_column_imputer import PerColumnImputer

def test_per_column_imputer():
    # 1. Filling numerical features
    X = pd.DataFrame({
        'f1': [1, np.nan, 3, 4],
        'f2': [np.nan, 2, 3, np.nan],
        'f3': [1, 2, 3, 4]
    })
    imputer = PerColumnImputer()
    X_imputed = imputer.fit_transform(X)
    assert not X_imputed.isnull().any().any()
    # 2. Custom filling strategy
    imputer = PerColumnImputer({
        'f1': 'mean',
        'f2': 'median',
        'f3': 0
    })
    X_imputed = imputer.fit_transform(X)
    assert not X_imputed.isnull().any().any()
    # 3. Custom filling function
    def custom_fill(x): return x.median() + 1
    imputer = PerColumnImputer({
        'f1': custom_fill,
        'f2': 'mean'
    })
    X_imputed = imputer.fit_transform(X)
    assert not X_imputed.isnull().any().any()
    # 4. Columns all NaN
    X = pd.DataFrame({
        'f1': [np.nan, np.nan, np.nan],
        'f2': [1, 2, 3]
    })
    imputer = PerColumnImputer()
    X_imputed = imputer.fit_transform(X)
    assert not X_imputed.isnull().any().any()

test_per_column_imputer()
```

### Node 9: DataFrame Utility Functions (DataFrame Utilities)
**Function Description**:
- Provides utility functions for time series data preprocessing, format conversion, and verification, supporting the conversion and verification of various data formats.

**Overview of Core Algorithms**:
- Data format verification and conversion.
- Time series data preprocessing.
- Missing value detection and handling.
- Data quality check.

**Input-Output Examples**:
```Python
import pandas as pd
import numpy as np
from tsfresh.utilities.dataframe_functions import impute, restrict_input_to_index

def test_dataframe_utilities():
    # 1. Missing value filling
    df = pd.DataFrame({
        'f1': [1, np.nan, 3],
        'f2': [np.nan, 2, 3]
    })
    df_imputed = impute(df)
    assert not df_imputed.isnull().any().any()
    # 2. Index restriction
    df = pd.DataFrame({'f1': [1, 2, 3, 4]}, index=[1, 2, 3, 4])
    target_index = [1, 3]
    df_restricted = restrict_input_to_index(df, target_index)
    assert set(df_restricted.index) == set(target_index)
    # 3. Data verification
    # Test the correctness of the time series data format
    # Test the integrity of the time series data
    # Test the consistency of the data types

test_dataframe_utilities()
```

### Node 10: Distributed Computing Support (Distributed Computing)
**Function Description**:
- Supports distributed feature extraction of large-scale time series data, providing multiple distributed computing backends and load balancing strategies.

**Overview of Core Algorithms**:
- Data sharding and task allocation.
- Parallel feature calculation.
- Result aggregation and merging.
- Error handling and fault tolerance mechanisms.

**Input-Output Examples**:
```Python
import pandas as pd
import numpy as np
from tsfresh.utilities.distribution import LocalDaskDistributor, MapDistributor

def test_distributed_computing():
    # 1. Local Dask distributed
    df = pd.DataFrame({
        'id': list(range(100)),
        'time': list(range(100)),
        'value': np.random.randn(100)
    })
    distributor = LocalDaskDistributor(n_jobs=4)
    # 2. Map distributed
    distributor = MapDistributor(n_jobs=2)
    # 3. Custom distributed
    # Implement a custom distributed computing backend
    # 4. Error handling
    # Test the exception handling in distributed computing
    # 5. Performance testing
    # Compare the performance of different distributed backends

test_distributed_computing()
```

### Node 11: Configuration Management and Settings (Configuration Management)
**Function Description**:
- Provides a flexible feature extraction parameter configuration system, supporting preset configurations, custom configurations, and dynamic configuration management.

**Overview of Core Algorithms**:
- Configuration parameter verification and default value setting.
- Configuration inheritance and override mechanism.
- Configuration serialization and deserialization.
- Configuration optimization and recommendation.

**Input-Output Examples**:
```Python
from tsfresh.feature_extraction import ComprehensiveFCParameters, MinimalFCParameters, EfficientFCParameters

def test_configuration_management():
    # 1. Preset configurations
    comprehensive_settings = ComprehensiveFCParameters()
    minimal_settings = MinimalFCParameters()
    efficient_settings = EfficientFCParameters()
    # 2. Custom configuration
    custom_settings = ComprehensiveFCParameters()
    custom_settings['mean'] = None
    custom_settings['std'] = None
    custom_settings['autocorrelation'] = [{'lag': 1}, {'lag': 2}]
    # 3. Configuration verification
    # Test the validity of the configuration parameters
    # 4. Configuration optimization
    # Recommend the optimal configuration based on the data characteristics

test_configuration_management()
```

### Node 12: Performance Monitoring and Optimization (Performance Monitoring)
**Function Description**:
- Provides performance monitoring, memory usage analysis, and optimization suggestions for the feature extraction process, supporting large-scale data processing.

**Overview of Core Algorithms**:
- Execution time statistics and analysis.
- Memory usage monitoring.
- Identification of performance bottlenecks.
- Recommendation of optimization strategies.

**Input-Output Examples**:
```Python
import pandas as pd
import numpy as np
from tsfresh import extract_features

def test_performance_monitoring():
    # 1. Performance analysis
    df = pd.DataFrame({
        'id': list(range(1000)),
        'time': list(range(1000)),
        'value': np.random.randn(1000)
    })
    # Enable performance analysis
    X = extract_features(
        df, 
        column_id='id', 
        column_sort='time',
        profile=True,
        profiling_filename="profile.txt"
    )
    # 2. Memory monitoring
    # Monitor the memory usage during the feature extraction process
    # 3. Performance optimization
    # Optimize the parameter settings based on the performance analysis results

test_performance_monitoring()
```

### Node 13: String Processing Utilities (String Manipulation Utilities)
**Function Description**:
- Provides utility functions for string processing, feature name parsing, LaTeX format handling, etc., supporting the standardization and parsing of feature names.

**Overview of Core Algorithms**:
- String cleaning and standardization.
- Feature name parsing and reconstruction.
- LaTeX mathematical expression handling.
- Encoding and format conversion.

**Input-Output Examples**:
```Python
import pandas as pd
from tsfresh.utilities.string_manipulation import get_config_between_strings, get_string_encoding

def test_string_manipulation():
    # 1. String configuration extraction
    s = "hello world"
    config = get_config_between_strings(s, "hello", "world")
    assert config == " "
    # 2. String encoding detection
    encoding = get_string_encoding("test string")
    assert encoding is not None
    # 3. Feature name handling
    # Test the standardization and parsing of feature names
    # 4. LaTeX expression handling
    # Test the parsing and conversion of LaTeX mathematical expressions

test_string_manipulation()
```

### Node 14: Statistical Significance Tests (Statistical Significance Tests)
**Function Description**:
- Implements multiple statistical significance test methods, including FDR control, multiple test corrections, etc., for statistical verification of feature selection.

**Overview of Core Algorithms**:
- Implementation of multiple statistical test methods.
- Multiple test correction algorithms.
- P-value calculation and significance judgment.
- Interpretation of statistical test results.

**Input-Output Examples**:
```Python
import numpy as np
import pandas as pd
from tsfresh.feature_selection.significance_tests import target_binary_feature_binary_test, target_real_feature_binary_test

def test_significance_tests():
    # 1. Binary target binary feature test
    x = np.array([0, 1, 0, 1])
    y = np.array([0, 1, 0, 1])
    p_value = target_binary_feature_binary_test(x, y)
    assert 0 <= p_value <= 1
    # 2. Real-valued target binary feature test
    x = np.array([0, 1, 0, 1])
    y = np.array([0.1, 0.9, 0.2, 0.8])
    p_value = target_real_feature_binary_test(x, y)
    assert 0 <= p_value <= 1
    # 3. Boundary condition testing
    # Test boundary conditions such as all the same values and empty arrays
    # 4. Statistical test performance
    # Test the performance of statistical tests on large-scale data

test_significance_tests()
```

### Node 15: Feature Relevance Calculation (Feature Relevance Calculation)
**Function Description**:
- Calculates the relevance indicators between features and the target variable, supporting multiple relevance measurement methods and feature importance evaluation.

**Overview of Core Algorithms**:
- Multiple relevance measurement methods.
- Feature importance calculation.
- Relevance sorting and filtering.
- Support for relevance visualization.

**Input-Output Examples**:
```Python
import numpy as np
import pandas as pd
from tsfresh.feature_selection.relevance import calculate_relevance_table

def test_feature_relevance():
    # 1. Relevance calculation
    X = pd.DataFrame({
        'f1': [1, 2, 3, 4],
        'f2': [4, 5, 6, 7],
        'f3': [1, 1, 1, 1]  # Constant feature
    })
    y = pd.Series([0, 1, 0, 1])
    relevance_table = calculate_relevance_table(X, y)
    assert len(relevance_table) > 0
    # 2. Feature importance
    # Test the calculation and sorting of feature importance
    # 3. Multi-class relevance
    y_multi = pd.Series([0, 1, 2, 1])
    relevance_table_multi = calculate_relevance_table(X, y_multi)
    # 4. Regression relevance
    y_reg = pd.Series([0.1, 0.9, 0.2, 0.8])
    relevance_table_reg = calculate_relevance_table(X, y_reg)

test_feature_relevance()
```

### Node 16: Time Series Data Validation (Time Series Data Validation)
**Function Description**:
- Verifies the format, integrity, and quality of time series data, providing data preprocessing and cleaning functions.

**Overview of Core Algorithms**:
- Data format verification.
- Time series integrity check.
- Data quality assessment.
- Outlier detection and handling.

**Input-Output Examples**:
```Python
import pandas as pd
import numpy as np
from tsfresh.utilities.dataframe_functions import check_for_nans_in_columns

def test_time_series_validation():
    # 1. NaN value check
    df = pd.DataFrame({
        'id': [1, 1, 2, 2],
        'time': [1, 2, 1, 2],
        'value': [1, np.nan, 3, 4]
    })
    has_nans = check_for_nans_in_columns(df, ['value'])
    assert has_nans
    # 2. Data format verification
    # Test the correctness of the time series data format
    # 3. Time series integrity
    # Check the continuity and integrity of the time series
    # 4. Outlier detection
    # Detect and handle outliers in the time series

test_time_series_validation()
```

### Node 17: Custom Feature Calculators (Custom Feature Calculators)
**Function Description**:
- Supports users to define custom feature calculation functions, providing an extension mechanism and registration system for feature calculators.

**Overview of Core Algorithms**:
- Custom function registration mechanism.
- Function parameter verification.
- Calculator performance optimization.
- Error handling and fault tolerance.

**Input-Output Examples**:
```Python
import numpy as np
import pandas as pd
from tsfresh.feature_extraction.feature_calculators import set_property

def test_custom_feature_calculators():
    # 1. Custom feature function
    @set_property("fctype", "simple")
    def custom_range(x):
        return np.max(x) - np.min(x)
    
    # 2. Function registration
    # Test the registration and use of custom functions
    # 3. Parameter verification
    # Test the verification and default value setting of function parameters
    # 4. Performance testing
    # Test the performance of custom functions

test_custom_feature_calculators()
```

### Node 18: Multivariate Time Series Processing (Multivariate Time Series Processing)
**Function Description**:
- Handles multivariate time series data, supporting correlation analysis between variables and joint feature extraction.

**Overview of Core Algorithms**:
- Multivariate data format processing.
- Correlation analysis between variables.
- Joint feature extraction.
- Multivariate feature selection.

**Input-Output Examples**:
```Python
import pandas as pd
import numpy as np
from tsfresh import extract_features

def test_multivariate_processing():
    # 1. Multivariate data format
    df = pd.DataFrame({
        'id': [1, 1, 1, 2, 2, 2],
        'time': [1, 2, 3, 1, 2, 3],
        'temp': [20, 21, 22, 23, 24, 25],
        'pressure': [100, 101, 102, 103, 104, 105],
        'humidity': [50, 51, 52, 53, 54, 55]
    })
    # 2. Multivariate feature extraction
    X = extract_features(df, column_id='id', column_sort='time')
    assert 'temp__mean' in X.columns
    assert 'pressure__mean' in X.columns
    assert 'humidity__mean' in X.columns
    # 3. Correlation between variables
    # Analyze the correlation features between multivariate variables
    # 4. Joint features
    # Extract multivariate joint features

test_multivariate_processing()
```

### Node 19: Event Sequence Processing (Event Sequence Processing)
**Function Description**:
- Handles event sequence data, supporting the calculation of special features such as the time interval between events and event frequency.

**Overview of Core Algorithms**:
- Event sequence format recognition.
- Calculation of the time interval between events.
- Event frequency analysis.
- Event pattern recognition.

**Input-Output Examples**:
```Python
import pandas as pd
import numpy as np
from tsfresh.feature_extraction.feature_calculators import number_peaks

def test_event_sequence_processing():
    # 1. Event sequence data
    df = pd.DataFrame({
        'id': [1, 1, 1, 2, 2, 2],
        'time': [1, 2, 3, 1, 2, 3],
        'event': [1, 0, 1, 0, 1, 0]
    })
    # 2. Event feature extraction
    X = extract_features(df, column_id='id', column_sort='time')
    # 3. Peak detection
    peaks = number_peaks(df['event'].values, 1)
    # 4. Event frequency
    # Calculate the frequency features of event occurrence

test_event_sequence_processing()
```

### Node 20: Irregular Sampling Data Processing (Irregular Sampling Processing)
**Function Description**:
- Handles irregularly sampled time series data, supporting data preprocessing techniques such as interpolation and resampling.

**Overview of Core Algorithms**:
- Detection of irregular data.
- Data interpolation algorithms.
- Resampling techniques.
- Missing value handling.

**Input-Output Examples**:
```Python
import pandas as pd
import numpy as np
from tsfresh.utilities.dataframe_functions import impute

def test_irregular_sampling():
    # 1. Irregularly sampled data
    df = pd.DataFrame({
        'id': [1, 1, 1, 2, 2],
        'time': [1, 3, 5, 1, 4],  # Irregular time intervals
        'value': [1, 3, 5, 2, 4]
    })
    # 2. Data interpolation
    # Interpolate the irregular data
    # 3. Resampling
    # Resample the irregular data into regular data
    # 4. Missing value handling
    df_with_nans = df.copy()
    df_with_nans.loc[1, 'value'] = np.nan
    df_imputed = impute(df_with_nans)

test_irregular_sampling()
```

### Node 21: Feature Extraction Settings Validation (Feature Extraction Settings Validation)
**Function Description**:
- Verifies the integrity and correctness of feature extraction settings, providing setting optimization suggestions and error detection.

**Overview of Core Algorithms**:
- Setting parameter verification.
- Setting integrity check.
- Setting optimization suggestions.
- Error detection and repair.

**Input-Output Examples**:
```Python
from tsfresh.feature_extraction import ComprehensiveFCParameters, MinimalFCParameters

def test_settings_validation():
    # 1. Setting verification
    settings = ComprehensiveFCParameters()
    # Verify the validity of the settings
    # 2. Setting optimization
    # Optimize the settings based on the data characteristics
    # 3. Error detection
    # Detect errors and conflicts in the settings
    # 4. Setting suggestions
    # Provide setting optimization suggestions

test_settings_validation()
```

### Node 22: Command Line Interface (Command Line Interface)
**Function Description**:
- Provides a command line interface, supporting batch feature extraction, feature selection, and result output, facilitating scripted processing.

**Overview of Core Algorithms**:
- Command line parameter parsing.
- Batch data processing.
- Result output formatting.
- Error handling and log recording.

**Input-Output Examples**:
```Python
import subprocess
import sys

def test_command_line_interface():
    # 1. Feature extraction command
    # Test the command line feature extraction function
    # 2. Feature selection command
    # Test the command line feature selection function
    # 3. Parameter verification
    # Test the validity of command line parameters
    # 4. Output format
    # Test the format of command line output

test_command_line_interface()
```

### Node 23: Example Data Generation (Example Data Generation)
**Function Description**:
- Generates various types of example time series data for testing and demonstration, supporting multiple data distributions and patterns.

**Overview of Core Algorithms**:
- Generation of multiple data distributions.
- Simulation of time series patterns.
- Injection of outliers.
- Data quality control.

**Input-Output Examples**:
```Python
import pandas as pd
import numpy as np
from tsfresh.examples import load_robot_execution_failures, load_har_dataset

def test_example_data_generation():
    # 1. Robot execution failure data
    df_robot, y_robot = load_robot_execution_failures()
    assert len(df_robot) > 0
    assert len(y_robot) > 0
    # 2. HAR dataset
    df_har, y_har = load_har_dataset()
    assert len(df_har) > 0
    assert len(y_har) > 0
    # 3. Custom example data
    # Generate custom example time series data
    # 4. Data quality verification
    # Verify the quality of the generated example data

test_example_data_generation()
```

### Node 24: Integration Testing (Integration Testing)
**Function Description**:
- Provides complete integration testing to verify the collaboration and data flow between various modules, ensuring the overall functionality correctness of the system.

**Overview of Core Algorithms**:
- End-to-end testing process.
- Interface testing between modules.
- Data flow verification.
- Performance integration testing.

**Input-Output Examples**:
```Python
import pandas as pd
import numpy as np
from tsfresh import extract_features, select_features, extract_relevant_features

def test_integration():
    # 1. Complete process testing
    df = pd.DataFrame({
        'id': [1, 1, 2, 2],
        'time': [1, 2, 1, 2],
        'value': [10, 20, 30, 40]
    })
    y = pd.Series([0, 1], index=[1, 2])
    
    # Feature extraction
    X = extract_features(df, column_id='id', column_sort='time')
    assert X.shape[0] == 2
    
    # Feature selection
    X_selected = select_features(X, y)
    assert X_selected.shape[1] <= X.shape[1]
    
    # Relevant feature extraction
    X_relevant = extract_relevant_features(df, y, column_id='id', column_sort='time')
    assert X_relevant.shape[0] == 2
    
    # 2. Transformer integration testing
    # Test the integration of transformers with sklearn
    # 3. Distributed integration testing
    # Test the integration of distributed computing
    # 4. Performance integration testing
    # Test the overall performance

test_integration()
```