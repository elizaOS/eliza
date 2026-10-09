# Introduction and Goals of the DESlib Project

DESlib is a Python machine learning library **focused on Dynamic Ensemble Selection (DES) and Dynamic Classifier Selection (DCS) techniques**. It is dedicated to providing researchers and engineers with implementations of the latest ensemble learning methods. Based on scikit-learn, this library is compatible with its API (fit, predict, predict_proba, score) and supports various mainstream ensemble methods and baseline algorithms, making it suitable for both academic research and practical engineering applications.

Core features include: Implementing more than a dozen mainstream Dynamic Ensemble Selection (DES) and Dynamic Classifier Selection (DCS) algorithms, such as META-DES, KNORA-E, KNORA-U, DES-P, KNOP, OLA, LCA, MCB, A Priori, A Posteriori, etc. **Supporting static ensemble methods** (e.g., Oracle, Single Best, Static Selection, Stacked Classifier) as comparison baselines. **Providing flexible local region definitions, classifier competence evaluation, and selection mechanisms**, supporting multiple distance metrics and KNN backends (the high-performance FAISS can be selected to accelerate large-scale data processing). Supporting heterogeneous classifier pools and being compatible with the scikit-learn ecosystem. Built-in with various ensemble method evaluation tools, aggregation functions, diversity metrics, instance hardness analysis, and other useful tools.

Project goals:
DESlib aims to become the standard tool library in the field of dynamic ensemble selection, promoting the research, application, and implementation of related algorithms. Its design concepts are as follows:
- Lowering the threshold for using DS/DCS methods, facilitating seamless integration with mainstream ML frameworks such as scikit-learn.
- Providing a modular and easily extensible architecture, facilitating the implementation of new algorithms and comparative experiments.
- Supporting efficient large-scale data processing (e.g., integrating FAISS) to meet the diverse needs of the industry and academia.

In short, DESlib aims to provide a one-stop, professional solution for the research and application of dynamic ensemble selection methods. It is an indispensable open-source tool in the field of ensemble learning (for example, create a dynamic ensemble selector using KNORAE(), train the DSEL region using fit(), and perform dynamic predictions using predict()).

---

# Natural Language Instruction (Prompt)

Please create a Python project named DESlib to implement a Dynamic Ensemble Selection (DES) and Dynamic Classifier Selection (DCS) algorithm library. This project should include the following functions:

1. **Algorithm implementation module**:
   - Implement more than a dozen mainstream Dynamic Ensemble Selection (DES) and Dynamic Classifier Selection (DCS) algorithms, including but not limited to META-DES, KNORA-E, KNORA-U, DES-P, KNOP, OLA, LCA, MCB, A Priori, A Posteriori, etc.
   - Support static ensemble methods (e.g., Oracle, Single Best, Static Selection, Stacked Classifier) as comparison baselines.
   - Each algorithm should be an independent Python class, all inheriting from a unified base class, with an interface style consistent with scikit-learn (fit, predict, predict_proba, score).

2. **Tool and evaluation module**:
   - Provide tool modules such as aggregation functions (e.g., majority voting, weighted voting), diversity metrics, and instance hardness analysis.
   - Support local region definition, classifier competence evaluation, and selection mechanisms, supporting multiple distance metrics and KNN backends (the high-performance FAISS can be selected to accelerate large-scale data processing).
   - Support heterogeneous classifier pools and be compatible with the scikit-learn ecosystem.

3. **Interface design**:
   - Each functional module (e.g., algorithm implementation, aggregation, diversity, KNN backend, etc.) should have an independent Python package and a clear API.
   - Provide a unified API entry (e.g., deslib/__init__.py) to export all major algorithms and tool classes. Users can directly access them using statements such as from deslib import KNORAE, META_DES.
   - All algorithm classes and tool functions should have detailed docstrings explaining the input and output formats and usage.

4. **Examples and test cases**:
   - Provide rich example code and test cases to demonstrate how to train, predict, and evaluate using various algorithms.
   - The examples should cover typical scenarios such as scikit-learn integration, FAISS acceleration, and heterogeneous classifier pools.
   - The test cases should cover all major functional modules to ensure the correctness and compatibility of the algorithms.

5. **Dependencies and installation**:
   - The project must include a complete setup.py file, supporting installation via pip install.
   - The setup.py file should declare a complete list of dependencies (e.g., scikit-learn, numpy, scipy, faiss, joblib, pytest, etc.) and be able to verify whether all functional modules work properly.
   - Provide requirements.txt and requirements-dev.txt for production and development environments, respectively.

6. **Documentation and version information**:
   - Provide detailed README.rst and docs/ documentation, introducing the project background, functions, usage, API description, citation methods, etc.
   - The deslib/__init__.py file should contain the __version__ variable to uniformly manage version information.

7. **Compatibility and extensibility**:
   - All algorithms and tools should be fully compatible with the scikit-learn API, supporting seamless integration with scikit-learn pipelines.
   - Support FAISS as an optional dependency for efficient KNN retrieval of large-scale data.
   - Adopt a modular and easily extensible architecture, facilitating the implementation and integration of new algorithms and tools.

8. **Project structure requirements**:
   - The deslib/ directory should include sub-packages such as des/, dcs/, static/, util/, tests/, corresponding to different algorithm and tool modules.
   - Each sub-package should have an __init__.py file to export major classes and functions.
   - The root directory should have core files such as setup.py, README.rst, requirements.txt, LICENSE.txt.

9. **API entry and main functions**:
   - The deslib/__init__.py file serves as the unified API entry, importing and exporting all core algorithms and tools.
   - Users can access all major functions using statements such as from deslib.des.knora_e import KNORAE.

10. **Evaluation and benchmarks**:
    - Provide a benchmarks/ directory containing performance evaluation scripts on typical datasets (e.g., UCI HIGGS).
    - Support multiple evaluation metrics and experimental configurations for easy algorithm comparison and reproduction.
11. **Core file requirements**: The project must include a complete setup.py file, which needs to configure the project as a standard Python package that can be installed via pip install, declaring a complete list of dependencies — including scikit-learn>=1.0.2 (support for basic machine learning algorithms), numpy>=1.17.0 (core for numerical computation), scipy>=1.4.0 (scientific computing tools), and other core libraries, ensuring the compatibility of functions such as dynamic selection algorithms, diversity metrics, and dataset processing. The setup.py file needs to be able to verify that all functional modules work properly, supporting full verification triggered by test commands, covering the consistency of base class interfaces (e.g., the method implementation of BaseDS), the prediction logic of dynamic selection algorithms (KNORAE, METADES, etc.), the effectiveness of static selection strategies (Oracle, SingleBest, etc.), and the correctness of utility functions in the util module (e.g., dataset generation make_xor, diversity metric Q_statistic). At the same time, it is necessary to provide deslib/__init__.py as the unified API entry, which needs to integrate key components from each core module: import dynamic ensemble selection algorithms (KNORAE, KNORAU, METADES, DESP, KNOP, DESKNN, DESClustering, DESMI, etc.) from the des module; import dynamic classifier selection algorithms (OLA, LCA, MCB, APriori, APosteriori, Rank, etc.) from the dcs module; import static selection methods (Oracle, SingleBest, StaticSelection, StackedClassifier, etc.) from the static module; import the base class BaseDS from the base module; import core utility functions (e.g., dataset generation make_P2, diversity calculation ratio_errors_errors, probability function softmax, etc.) from the util module. In addition, version information needs to be provided through __version__, ensuring that users can directly access the main functions through a simple from deslib import KNORAE, OLA, Oracle statement without paying attention to the internal module structure. In deslib/base.py, the BaseDS base class needs to define the general interface for dynamic selection algorithms, standardizing the implementation standards for all subclasses: the core methods include fit(X, y) (training the model, fitting the base classifiers and the dynamic selection mechanism), predict(X) (predicting sample labels), predict_proba(X) (outputting the class probability distribution), ensuring the consistency of the basic training and prediction processes of the algorithms; the abstract methods include estimate_competence(X) (estimating the competence of base classifiers on samples), select(X) (selecting the optimal subset of base classifiers based on competence), classify_with_ds(X) (performing the final prediction based on the selection results), forcing subclasses with different dynamic selection strategies (e.g., neighborhood selection in KNORAU, global accuracy competence evaluation in OLA) to provide a unified extension framework. The base class also needs to integrate the tools in the util module (e.g., faiss_knn_wrapper for neighborhood search, hardness_region_competence for sample hardness evaluation), providing basic tool support for subclasses and ensuring the consistency of all dynamic selection algorithms at the API level, reducing the user's learning cost and the migration cost of switching between algorithms.
---

## Environment Configuration

### Python Version
The Python version used in the current project is: Python 3.12.4
### Core Dependency Library Versions

```
# Core machine learning computation libraries
scipy>=1.4.0                    # Basic scientific computing library
numpy>=1.17.0                   # Basic numerical computation
scikit-learn>=1.0.2             # Machine learning algorithm and model framework

# Optional high-performance dependencies
faiss-cpu>=1.7.0                # Efficient KNN retrieval (optional)
faiss-gpu>=1.7.0                # GPU-accelerated KNN (optional)

# Documentation and development support libraries
sphinx                          # Documentation generation
sphinx_rtd_theme                # Documentation theme
numpydoc                        # Numpy-style documentation support
sphinx_gallery                  # Example documentation generation
matplotlib>=2                   # Visualization support
pillow                          # Image processing

# Testing and quality assurance
pytest                          # Unit testing framework
coverage                        # Coverage statistics
pytest-cov                      # pytest coverage plugin
nose                            # Testing framework
```

---

## DESlib Project Architecture

### Project Directory Structure

```
workspace/
├── .circleci
│   ├── config.yml
├── .coveragerc
├── .gitignore
├── .pep8speaks.yml
├── .readthedocs.yml
├── CONTRIBUTING.md
├── LICENSE.txt
├── MANIFEST.in
├── README.rst
├── benchmarks
│   ├── bench_ds_performance_faiss.py
│   ├── bench_knn_backbone.py
│   ├── bench_speed_faiss.py
├── deslib
│   ├── __init__.py
│   ├── base.py
│   ├── dcs
│   │   ├── __init__.py
│   │   ├── a_posteriori.py
│   │   ├── a_priori.py
│   │   ├── base.py
│   │   ├── lca.py
│   │   ├── mcb.py
│   │   ├── mla.py
│   │   ├── ola.py
│   │   ├── rank.py
│   ├── des
│   │   ├── __init__.py
│   │   ├── base.py
│   │   ├── des_clustering.py
│   │   ├── des_knn.py
│   │   ├── des_mi.py
│   │   ├── des_p.py
│   │   ├── knop.py
│   │   ├── knora_e.py
│   │   ├── knora_u.py
│   │   ├── meta_des.py
│   │   ├── probabilistic
│   │   │   ├── __init__.py
│   │   │   ├── base.py
│   │   │   ├── deskl.py
│   │   │   ├── exponential.py
│   │   │   ├── logarithmic.py
│   │   │   ├── minimum_difference.py
│   │   │   └── rrc.py
│   ├── static
│   │   ├── __init__.py
│   │   ├── base.py
│   │   ├── oracle.py
│   │   ├── single_best.py
│   │   ├── stacked.py
│   │   └── static_selection.py
│   ├── util
│   │   ├── __init__.py
│   │   ├── aggregation.py
│   │   ├── datasets.py
│   │   ├── dfp.py
│   │   ├── diversity.py
│   │   ├── diversity_batch.py
│   │   ├── faiss_knn_wrapper.py
│   │   ├── instance_hardness.py
│   │   ├── knne.py
│   │   └── prob_functions.py
├── docs
│   ├── .gitignore
│   ├── Makefile
│   ├── _static
│   │   ├── .keep
│   ├── api.rst
│   ├── conf.py
│   ├── index.rst
│   ├── make.bat
│   ├── modules
│   │   ├── dcs
│   │   │   ├── a_posteriori.rst
│   │   │   ├── a_priori.rst
│   │   │   ├── lca.rst
│   │   │   ├── mcb.rst
│   │   │   ├── mla.rst
│   │   │   ├── ola.rst
│   │   │   └── rank.rst
│   │   ├── des
│   │   │   ├── des_clustering.rst
│   │   │   ├── des_p.rst
│   │   │   ├── deskl.rst
│   │   │   ├── desmi.rst
│   │   │   ├── ds_knn.rst
│   │   │   ├── exponential.rst
│   │   │   ├── knop.rst
│   │   │   ├── knora_e.rst
│   │   │   ├── knora_u.rst
│   │   │   ├── logarithmic.rst
│   │   │   ├── meta_des.rst
│   │   │   ├── minimum_difference.rst
│   │   │   ├── probabilistic.rst
│   │   │   └── rrc.rst
│   │   ├── static
│   │   │   ├── oracle.rst
│   │   │   ├── single_best.rst
│   │   │   ├── stacked.rst
│   │   │   └── static_selection.rst
│   │   ├── util
│   │   │   ├── aggregation.rst
│   │   │   ├── datasets.rst
│   │   │   ├── dfp.rst
│   │   │   ├── diversity.rst
│   │   │   ├── faiss_knn_wrapper.rst
│   │   │   ├── instance_hardness.rst
│   │   │   ├── knne.rst
│   │   │   └── prob_functions.rst
│   ├── news
│   │   ├── v0.1.rst
│   │   ├── v0.2.rst
│   │   ├── v0.3.5.rst
│   │   └── v0.3.rst
│   ├── news.rst
│   ├── user_guide
│   │   ├── development.rst
│   │   ├── installation.rst
│   │   ├── known_issues.rst
│   │   ├── packaging.rst
│   │   └── tutorial.rst
│   ├── user_guide.rst
├── examples
│   ├── README.txt
│   ├── example_calibrating_classifiers.py
│   ├── example_heterogeneous.py
│   ├── plot_comparing_dynamic_static.py
│   ├── plot_example_DFP.py
│   ├── plot_example_P2.py
│   ├── plot_influence_k_value.py
│   ├── plot_random_forest.py
│   ├── plot_using_instance_hardness.py
│   ├── plot_xor_example.py
│   └── simple_example.py
└── setup.py

```

---

## API Usage Guide

### Core API

#### 1. Module Import

```python
from deslib.base import BaseDS
from deslib.dcs.a_posteriori import APosteriori
from deslib.dcs.a_priori import APriori
from deslib.dcs.base import BaseDCS
from deslib.dcs.lca import LCA
from deslib.dcs.mcb import MCB
from deslib.dcs.mla import MLA
from deslib.dcs.ola import OLA
from deslib.dcs.rank import Rank
from deslib.des.base import BaseDES
from deslib.des.des_clustering import DESClustering
from deslib.des.des_knn import DESKNN
from deslib.des.des_mi import DESMI
from deslib.des.des_p import DESP
from deslib.des.knop import KNOP
from deslib.des.knora_e import KNORAE
from deslib.des.knora_u import KNORAU
from deslib.des.meta_des import METADES
from deslib.des.probabilistic import (
    BaseProbabilistic, Logarithmic, Exponential, RRC, DESKL, MinimumDifference
)
from deslib.static.oracle import Oracle
from deslib.static.single_best import SingleBest
from deslib.static.stacked import StackedClassifier
from deslib.static.static_selection import StaticSelection
from deslib.util import faiss_knn_wrapper
from deslib.util.knne import KNNE
from deslib.util.datasets import (
    make_P2, make_banana, make_banana2, make_circle_square, make_xor
)
from deslib.util.dfp import frienemy_pruning, frienemy_pruning_preprocessed
from deslib.util.diversity import (
    _process_predictions, double_fault, Q_statistic, ratio_errors, agreement_measure,
    disagreement_measure, correlation_coefficient, negative_double_fault
)
from deslib.util.diversity_batch import (
    _process_predictions, double_fault, Q_statistic, ratio_errors,
    agreement_measure, disagreement_measure, correlation_coefficient
)
from deslib.util.instance_hardness import hardness_region_competence, kdn_score
from deslib.util.prob_functions import (
    ccprmod, log_func, min_difference, softmax, exponential_func, entropy_func
)
```

#### 2. KNORAE Class - K-Nearest Oracles Eliminate

**Import Statement**:
```python
from deslib.des.knora_e import KNORAE
```

**Function**: k-Nearest Oracles Eliminate (KNORA-E). This method searches for a local Oracle, which is a base classifier that correctly classify all samples belonging to the region of competence of the test sample.

**Class Definition**:
```python
class KNORAE(BaseDES):
    """k-Nearest Oracles Eliminate (KNORA-E).

    This method searches for a local Oracle, which is a base classifier
    that correctly classify all samples belonging to the region of competence
    of the test sample. All classifiers with a perfect performance in the
    region of competence are selected (local Oracles). In the case that no
    classifier achieves a perfect accuracy, the size of the competence region
    is reduced (by removing the farthest neighbor) and the performance of the
    classifiers are re-evaluated. The outputs of the selected ensemble of
    classifiers is combined using the majority voting scheme. If no base
    classifier is selected, the whole pool is used for classification.

    References
    ----------
    Ko, Albert HR, Robert Sabourin, and Alceu Souza Britto Jr.
    "From dynamic classifier selection to dynamic ensemble
    selection." Pattern Recognition 41.5 (2008): 1718-1731.

    Britto, Alceu S., Robert Sabourin, and Luiz ES Oliveira. "Dynamic selection
    of classifiers—a comprehensive review."
    Pattern Recognition 47.11 (2014): 3665-3680

    R. M. O. Cruz, R. Sabourin, and G. D. Cavalcanti, "Dynamic classifier
    selection: Recent advances and perspectives,"
    Information Fusion, vol. 41, pp. 195 – 216, 2018.
    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=7, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, random_state=None,
             knn_classifier='knn', knn_metric='minkowski', knne=False,
             DSEL_perc=0.5, n_jobs=-1, voting='hard'):
    """Initialize the KNORAE classifier.

    Parameters
    ----------
    pool_classifiers : list of classifiers, default=None
        The pool of classifiers.
    k : int, default=7
        Number of neighbors.
    DFP : bool, default=False
        Whether to use Dynamic Frienemy Pruning.
    with_IH : bool, default=False
        Whether to use Instance Hardness.
    safe_k : int, default=None
        Safe k value for IH.
    IH_rate : float, default=0.30
        Instance Hardness rate.
    random_state : int, default=None
        Random state for reproducibility.
    knn_classifier : str, default='knn'
        KNN classifier type.
    knn_metric : str, default='minkowski'
        Distance metric for KNN.
    knne : bool, default=False
        Whether to use KNNE.
    DSEL_perc : float, default=0.5
        Percentage of data for DSEL.
    n_jobs : int, default=-1
        Number of parallel jobs.
    voting : str, default='hard'
        Voting method.
    """

def estimate_competence(self, competence_region, distances=None,
                        predictions=None):
    """Estimate the competence of the base classifiers.
    
    In the case of the KNORA-E technique, the classifiers are only 
    considered competent when they achieve a 100% accuracy in the 
    region of competence. For each base, we estimate the maximum size 
    of the region of competence that it is a local oracle.

    Parameters
    ----------
    competence_region : array of shape (n_samples, n_neighbors)
        Indices of the k nearest neighbors.
    distances : array of shape (n_samples, n_neighbors)
        Distances from the k nearest neighbors to the query.
    predictions : array of shape (n_samples, n_classifiers)
        Predictions of the base classifiers for all test examples.

    Returns
    -------
    competences : array of shape (n_samples, n_classifiers)
        Competence level estimated for each base classifier and test example.
    """

def select(self, competences):
    """Select all base classifiers that obtained a local accuracy of 100%.
    
    Selects all base classifiers that obtained a local accuracy of 100%
    in the region of competence (i.e., local oracle). In the case that no
    base classifiers obtain 100% accuracy, the size of the region of
    competence is reduced and the search for the local oracle is restarted.

    Parameters
    ----------
    competences : array of shape (n_samples, n_classifiers)
        Competence level estimated for each base classifier and test example.

    Returns
    -------
    selected_classifiers : array of shape (n_samples, n_classifiers)
        Boolean matrix containing True if the base classifier is selected,
        False otherwise.
    """
```

**Parameter Description**:
- `pool_classifiers` (list, default=None): The generated_pool of classifiers trained for the corresponding classification problem. Each base classifiers should support the method "predict". If None, then the pool of classifiers is a bagging classifier.
- `k` (int, default=7): Number of neighbors used to estimate the competence of the base classifiers.
- `DFP` (bool, default=False): Determines if the dynamic frienemy pruning is applied.
- `with_IH` (bool, default=False): Whether the hardness level of the region of competence is used to decide between using the DS algorithm or the KNN for classification of a given query sample.
- `safe_k` (int, default=None): The size of the indecision region.
- `IH_rate` (float, default=0.30): Hardness threshold. If the hardness level of the competence region is lower than the IH_rate the KNN classifier is used. Otherwise, the DS algorithm is used for classification.
- `random_state` (int, RandomState instance or None, default=None): Random state for reproducibility.
- `knn_classifier` ({'knn', 'faiss', None}, default='knn'): The algorithm used to estimate the region of competence.
- `knn_metric` ({'minkowski', 'cosine', 'mahalanobis'}, default='minkowski'): The metric used by the k-NN classifier to estimate distances.
- `knne` (bool, default=False): Whether to use K-Nearest Neighbor Equality (KNNE) for the region of competence estimation.
- `DSEL_perc` (float, default=0.5): Percentage of the input data used to fit DSEL.
- `n_jobs` (int, default=-1): The number of parallel jobs to run.
- `voting` ({'hard', 'soft'}, default='hard'): If 'hard', uses predicted class labels for majority rule voting. Else if 'soft', predicts the class label based on the argmax of the sums of the predicted probabilities.

#### 3. OLA Class - Dynamic Classifier Selection

**Import Statement**:
```python
from deslib.dcs.ola import OLA
```

**Function**: Dynamically select a single optimal classifier based on the local accuracy in the neighborhood.

**Class Definition**:
```python
class OLA(BaseDCS):
    """Overall Classifier Accuracy (OLA).

    The OLA method evaluates the competence level of each individual
    classifiers and select the most competent one to predict the label of each
    test sample x. The competence of each base classifier is calculated as its
    classification accuracy in the neighborhood of x (region of competence).

    The OLA method selects the base classifier presenting the highest
    competence level. In a case where more than one base classifier achieves
    the same competence level, the one that was evaluated first is selected.
    The selection methodology can be modified by changing the hyper-parameter
    selection_method.
    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=7, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, selection_method='best',
             diff_thresh=0.1, random_state=None, knn_classifier='knn',
             knn_metric='minkowski', knne=False, DSEL_perc=0.5, n_jobs=-1):
    """Initialize the OLA classifier.

    Parameters
    ----------
    pool_classifiers : list, default=None
        Classifier pool.
    k : int, default=7
        Number of neighbors.
    DFP : bool, default=False
        Whether to enable dynamic frienemy pruning.
    with_IH : bool, default=False
        Whether to use instance hardness.
    safe_k : int, default=None
        Number of safe neighbors.
    IH_rate : float, default=0.30
        Instance hardness threshold.
    selection_method : str, default='best'
        Selection method ('best', 'random', 'diff').
    diff_thresh : float, default=0.1
        Difference threshold.
    random_state : int, default=None
        Random seed.
    knn_classifier : str, default='knn'
        KNN implementation ('knn' or 'faiss').
    knn_metric : str, default='minkowski'
        Distance metric.
    knne : bool, default=False
        Whether to use KNNE.
    DSEL_perc : float, default=0.5
        Proportion of DSEL data.
    n_jobs : int, default=-1
        Number of parallel jobs.
    """

def estimate_competence(self, competence_region, distances=None, predictions=None):
    """Estimate the competence of each base classifier.
    
    The competence is calculated as the accuracy of each base classifier
    in the region of competence.

    Parameters
    ----------
    competence_region : array of shape (n_samples, n_neighbors)
        Indices of the k nearest neighbors.
    distances : array of shape (n_samples, n_neighbors), optional
        Distances from the k nearest neighbors to the query.
    predictions : array of shape (n_samples, n_classifiers), optional
        Predictions of the base classifiers for the test samples.

    Returns
    -------
    competences : array of shape (n_samples, n_classifiers)
        Competence level estimated for each base classifier and test sample.
    """
```

**Parameter Description**:
- `pool_classifiers` (list, default=None): The generated_pool of classifiers trained for the corresponding classification problem. Each base classifiers should support the method "predict". If None, then the pool of classifiers is a bagging classifier.
- `k` (int, default=7): Number of neighbors used to estimate the competence of the base classifiers.
- `DFP` (bool, default=False): Determines if the dynamic frienemy pruning is applied.
- `with_IH` (bool, default=False): Whether the hardness level of the region of competence is used to decide between using the DS algorithm or the KNN for classification of a given query sample.
- `safe_k` (int, default=None): The size of the indecision region.
- `IH_rate` (float, default=0.30): Hardness threshold. If the hardness level of the competence region is lower than the IH_rate the KNN classifier is used. Otherwise, the DS algorithm is used for classification.
- `selection_method` (str, default='best'): Determines which method is used to select the base classifier after the competences are estimated.
- `diff_thresh` (float, default=0.1): Threshold to measure the difference between the competence level of the base classifiers for the random and diff selection schemes.
- `random_state` (int, RandomState instance or None, default=None): Random state for reproducibility.
- `knn_classifier` ({'knn', 'faiss', None}, default='knn'): The algorithm used to estimate the region of competence.
- `knn_metric` ({'minkowski', 'cosine', 'mahalanobis'}, default='minkowski'): The metric used by the k-NN classifier to estimate distances.
- `knne` (bool, default=False): Whether to use K-Nearest Neighbor Equality (KNNE) for the region of competence estimation.
- `DSEL_perc` (float, default=0.5): Percentage of the input data used to fit DSEL.
- `n_jobs` (int, default=-1): The number of parallel jobs to run.

**Return Value**: None (constructor method that initializes the OLA classifier instance)

#### 4. Oracle Class - Static Ensemble Method

**Import Statement**:
```python
from deslib.static.oracle import Oracle
```

**Function**: An idealized static ensemble baseline. The prediction is considered correct if any classifier in the pool predicts correctly.

**Class Definition**:
```python
class Oracle(BaseStaticEnsemble):
    """Abstract method that always selects the base classifier that predicts
    the correct label if such classifier exists. This method is often used to
    measure the upper-limit performance that can be achieved by a dynamic
    classifier selection technique. It is used as a benchmark by several
    dynamic selection algorithms.
    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, random_state=None, n_jobs=-1):
    """Initialize the Oracle ensemble.

    Parameters
    ----------
    pool_classifiers : list, default=None
        List of classifier pools.
    random_state : int, default=None
        Random seed.
    n_jobs : int, default=-1
        Number of parallel jobs.
    """

def fit(self, X, y):
    """Fit the Oracle ensemble.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        The input data.
    y : array of shape (n_samples)
        Class labels of each example in X.

    Returns
    -------
    self
    """

def predict(self, X, y):
    """Predict class labels using Oracle method.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        The input data.
    y : array of shape (n_samples)
        True class labels (required for Oracle to determine correct predictions).

    Returns
    -------
    predicted_labels : array of shape (n_samples)
        Predicted class labels.
    """

def predict_proba(self, X, y):
    """Predict class probabilities using Oracle method.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        The input data.
    y : array of shape (n_samples)
        True class labels (required for Oracle to determine correct predictions).

    Returns
    -------
    predicted_proba : array of shape (n_samples, n_classes)
        Predicted class probabilities.
    """

def score(self, X, y, sample_weights=None):
    """Return the mean accuracy on the given test data and labels.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Test samples.
    y : array of shape (n_samples)
        True labels for X.
    sample_weights : array of shape (n_samples), default=None
        Sample weights.

    Returns
    -------
    score : float
        Mean accuracy of Oracle predictions.
    """
```

**Parameter Description**:
- `pool_classifiers` (list, default=None): The generated_pool of classifiers trained for the corresponding classification problem. Each base classifiers should support the method "predict". If None, then the pool of classifiers is a bagging classifier.
- `random_state` (int, RandomState instance or None, default=None): Random state for reproducibility.
- `n_jobs` (int, default=-1): The number of parallel jobs to run.

**Important Note**: The `predict` and `predict_proba` methods of Oracle require both X and y parameters to be passed in because Oracle needs to know the true labels to determine which classifier predicts correctly.

#### 5. FaissKNNClassifier Class - Efficient KNN Support

**Import Statement**:
```python
from deslib.util.faiss_knn_wrapper import FaissKNNClassifier, is_available
```

**Function**: An efficient KNN region definer based on FAISS, suitable for large-scale data.

**Class Definition**:
```python
class FaissKNNClassifier:
    """Scikit-learn wrapper interface for Faiss KNN.
    
    Parameters
    ----------
    n_neighbors : int (Default = 5)
                Number of neighbors used in the nearest neighbor search.

    n_jobs : int (Default = None)
             The number of jobs to run in parallel for both fit and predict.
              If -1, then the number of jobs is set to the number of cores.

    algorithm : {'brute', 'voronoi'} (Default = 'brute')
        Algorithm used to compute the nearest neighbors.

    n_cells : int (Default = 100)
        Number of voronoi cells. Only used when algorithm=='voronoi'.

    n_probes : int (Default = 1)
        Number of cells that are visited to perform the search.
    """
    def __init__(self, n_neighbors=5, n_jobs=None, algorithm='brute', 
                 n_cells=100, n_probes=1): ...
    def fit(self, X, y): ...
    def predict(self, X): ...
    def predict_proba(self, X): ...
    def kneighbors(self, X, n_neighbors=None, return_distance=True): ...
    def _prepare_knn_algorithm(self, X, d): ...
```

**Parameter Description**:
- `n_neighbors` (int, default=5): Number of neighbors used in the nearest neighbor search
- `n_jobs` (int, default=None): The number of jobs to run in parallel for both fit and predict
- `algorithm` ({'brute', 'voronoi'}, default='brute'): Algorithm used to compute the nearest neighbors
- `n_cells` (int, default=100): Number of voronoi cells. Only used when algorithm=='voronoi'
- `n_probes` (int, default=1): Number of cells that are visited to perform the search

**Method Description**:
- `fit(self, X, y)`: Fits the FaissKNNClassifier to the training data.
- `predict(self, X)`: Predicts class labels for the input data X.
- `predict_proba(self, X)`: Predicts class probabilities for the input data X.
- `kneighbors(self, X, n_neighbors=None, return_distance=True)`: Finds the k-nearest neighbors for each sample in X.
- `_prepare_knn_algorithm(self, X, d)`: Prepares the KNN algorithm based on the input data X and the number of neighbors d.

**Return Value**: None (constructor method that initializes the FaissKNNClassifier instance for high-performance KNN operations)

**Note**: The faiss library needs to be installed to use this class. Use `is_available()` to check if Faiss is properly installed.

#### 6. BaseStaticEnsemble Class - Base Static Ensemble

**Import Statement**:
```python
from deslib.static.base import BaseStaticEnsemble
```

**Function**: Base class for static ensemble methods that combine classifiers without dynamic selection.

**Class Definition**:
```python
class BaseStaticEnsemble(BaseEstimator, ClassifierMixin):
    """Base class for static ensemble methods.
    
    Provides common functionality for static ensemble techniques
    that combine classifiers without dynamic selection.
    """
    __metaclass__ = ABCMeta
```

**Core Methods**:
```python
@abstractmethod
def __init__(self, pool_classifiers=None, random_state=None, n_jobs=-1):
    """Initialize the base static ensemble.

    Parameters
    ----------
    pool_classifiers : list, default=None
        List of base classifiers.
    random_state : int, default=None
        Random seed.
    n_jobs : int, default=-1
        Number of parallel jobs.
    """

def fit(self, X, y):
    """Train the static ensemble method.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        The input data.
    y : array of shape (n_samples)
        Class labels of each example in X.

    Returns
    -------
    self
    """

def _check_label_encoder(self):
    """Check if the label encoder is properly configured.

    Returns
    -------
    bool
        True if label encoder is valid, False otherwise.
    """

def _setup_label_encoder(self, y):
    """Setup the label encoder for the target labels.

    Parameters
    ----------
    y : array of shape (n_samples)
        Target labels to encode.
    
    Returns
    -------
    y_ind : array of shape (n_samples)
        Encoded labels as integers.
    """

def _encode_base_labels(self, y):
    """Encode the base classifier labels using the label encoder.

    Parameters
    ----------
    y : array of shape (n_samples)
        Labels to encode.

    Returns
    -------
    y_encoded : array of shape (n_samples)
        Encoded labels.
    """

def _validate_pool(self):
    """Validate the pool of classifiers.

    Raises
    ------
    ValueError
        If the pool is invalid or empty.
    """
```

#### 7. SingleBest Class - Single Best Classifier

**Import Statement**:
```python
from deslib.static.single_best import SingleBest
```

**Function**: Static ensemble method that selects the single best performing classifier from the pool.

**Class Definition**:
```python
class SingleBest(BaseStaticEnsemble):
    """Single Best static ensemble method.
    
    Selects the single best performing classifier from the pool
    based on a specified scoring metric.
    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, scoring=None,
             random_state=None, n_jobs=-1):
    """Initialize the SingleBest classifier.

    Parameters
    ----------
    pool_classifiers : list, default=None
        List of base classifiers.
    scoring : str, default=None
        Scoring metric for selection.
    random_state : int, default=None
        Random seed.
    n_jobs : int, default=-1
        Number of parallel jobs.
    """

def fit(self, X, y):
    """Train and select the best classifier from the pool.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Training data.
    y : array of shape (n_samples)
        Target values.

    Returns
    -------
    self : object
        Returns the instance itself.
    """

def _estimate_performances(self, X, y):
    """Estimate performance of each classifier in the pool.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Training data.
    y : array of shape (n_samples)
        Target values.

    Returns
    -------
    performances : array of shape (n_classifiers)
        Performance scores for each classifier.
    """

def predict(self, X):
    """Predict using the best classifier.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Test samples.

    Returns
    -------
    y_pred : array of shape (n_samples)
        Predicted class labels.
    """

def predict_proba(self, X):
    """Predict probabilities using the best classifier.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Test samples.

    Returns
    -------
    probabilities : array of shape (n_samples, n_classes)
        Predicted class probabilities.
    """

def _check_is_fitted(self):
    """Check if the model is fitted.

    Raises
    ------
    NotFittedError
        If the model is not fitted.
    """
```

**Parameter Description**:
- `pool_classifiers` (list): List of base classifiers, default is None
- `scoring` (str): Scoring metric for selection, default is 'accuracy'
- `random_state` (int): Random seed, default is None
- `n_jobs` (int): Number of parallel jobs, default is -1

#### 8. StaticSelection Class - Static Selection

**Import Statement**:
```python
from deslib.static.static_selection import StaticSelection
```

**Function**: Static ensemble method that selects a fixed subset of classifiers based on their performance.

**Class Definition**:
```python
class StaticSelection(BaseStaticEnsemble):
    """Ensemble model that selects N classifiers with the best performance in a
    dataset

    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, pct_classifiers=0.5,
             scoring=None, random_state=None, n_jobs=-1):
    """Initialize the StaticSelection classifier.

    Parameters
    ----------
    pool_classifiers : list, default=None
        List of base classifiers.
    pct_classifiers : float, default=0.5
        Percentage of classifiers to select.
    scoring : str, default=None
        Scoring metric for selection.
    random_state : int, default=None
        Random seed.
    n_jobs : int, default=-1
        Number of parallel jobs.
    """

def fit(self, X, y):
    """Train and select classifier subset based on performance.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Training data.
    y : array of shape (n_samples)
        Target values.

    Returns
    -------
    self : object
        Returns the instance itself.
    """

def predict(self, X):
    """Predict using selected classifiers with majority voting.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Test samples.

    Returns
    -------
    y_pred : array of shape (n_samples)
        Predicted class labels.
    """

def predict_proba(self, X):
    """Predict probabilities using selected classifiers.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Test samples.

    Returns
    -------
    probabilities : array of shape (n_samples, n_classes)
        Predicted class probabilities (averaged).
    """

def _validate_parameters(self):
    """Validate static selection parameters.

    Raises
    ------
    ValueError
        If parameters are invalid.
    """

def _check_is_fitted(self):
    """Check if the model is fitted.

    Raises
    ------
    NotFittedError
        If the model is not fitted.
    """

def _check_predict_proba(self):
    """Check predict_proba capability of selected classifiers.

    Raises
    ------
    ValueError
        If selected classifiers don't support predict_proba.
    """
```

**Parameter Description**:
- `pool_classifiers` (list): List of base classifiers, default is None
- `pct_classifiers` (float): Percentage of classifiers to select, default is 0.5
- `scoring` (str): Scoring metric for selection, default is 'accuracy'
- `random_state` (int): Random seed, default is None
- `n_jobs` (int): Number of parallel jobs, default is -1

#### 9. StackedClassifier Class - Stacked Classifier

**Import Statement**:
```python
from deslib.static.stacked import StackedClassifier
```

**Function**: Static ensemble method that uses stacking with a meta-classifier to combine base classifier predictions.

**Class Definition**:
```python
class StackedClassifier(BaseStaticEnsemble):
    """
    A Stacking classifier.
    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, meta_classifier=None,
             passthrough=False, random_state=None, n_jobs=-1):
    """Initialize the StackedClassifier.

    Parameters
    ----------
    pool_classifiers : list, default=None
        List of base classifiers.
    meta_classifier : object, default=None
        Meta-classifier instance for stacking.
    passthrough : bool, default=False
        Whether to pass original features to meta-classifier.
    random_state : int, default=None
        Random seed.
    n_jobs : int, default=-1
        Number of parallel jobs.
    """

def fit(self, X, y):
    """Train the stacked classifier with base and meta classifiers.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Training data.
    y : array of shape (n_samples)
        Target values.

    Returns
    -------
    self : object
        Returns the instance itself.
    """

def predict(self, X):
    """Predict using stacked approach with meta-classifier.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Test samples.

    Returns
    -------
    y_pred : array of shape (n_samples)
        Predicted class labels from meta-classifier.
    """

def predict_proba(self, X):
    """Predict probabilities using stacked approach.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Test samples.

    Returns
    -------
    probabilities : array of shape (n_samples, n_classes)
        Predicted class probabilities from meta-classifier.
    """

def _connect_input(self, X, base_preds):
    """Connect input features with base predictions for meta-classifier.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Original input features.
    base_preds : array of shape (n_samples, n_base_classifiers)
        Base classifier predictions.

    Returns
    -------
    meta_input : array of shape (n_samples, n_features + n_base_classifiers)
        Combined input for meta-classifier.
    """

def _predict_proba_base(self, X):
    """Get base classifier probabilities.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Test samples.

    Returns
    -------
    base_probas : array of shape (n_samples, n_base_classifiers, n_classes)
        Probabilities from each base classifier.
    """

def _check_predict_proba(self):
    """Check predict_proba capability of base classifiers.

    Raises
    ------
    ValueError
        If base classifiers don't support predict_proba.
    """
```

**Parameter Description**:
- `pool_classifiers` (list): List of base classifiers, default is None
- `meta_classifier`: Meta-classifier instance for stacking, default is None
- `passthrough` (bool): Whether to pass original features to meta-classifier, default is False
- `random_state` (int): Random seed, default is None
- `n_jobs` (int): Number of parallel jobs, default is -1

#### 10. KNNE Class - K-Nearest Neighbors Equality

**Import Statement**:
```python
from deslib.util.knne import KNNE
```

**Function**: K-Nearest Neighbors-Equality technique implementation. Fits different KNN methods for each class and searches for nearest examples within each class separately.

**Class Definition**:
```python
class KNNE(BaseEstimator):
    """Implementation of the K-Nearest Neighbors-Equality technique.

    This implementation fits a different KNN method for each class, and search
    on each class for the nearest examples.

    Parameters
    ----------
    n_neighbors : int, (default = 7)
        Number of neighbors to use by default for :meth:`kneighbors` queries.

    knn_classifier : str = ['knn', 'faiss'], (default = 'sklearn')
        Whether to use scikit-learn or faiss for nearest neighbors estimation.

    References
    ----------
    Sierra, Basilio, Elena Lazkano, Itziar Irigoien, Ekaitz Jauregi,
    and Iñigo Mendialdua. "K nearest neighbor equality: giving equal chance
    to all existing classes."
    Information Sciences 181, no. 23 (2011): 5158-5168.

    Mendialdua, Iñigo, José María Martínez-Otzeta, I. Rodriguez-Rodriguez,
    T. Ruiz-Vazquez, and Basilio Sierra. "Dynamic selection of the best base
    classifier in one versus one." Knowledge-Based Systems 85 (2015): 298-306.

    Cruz, Rafael MO, Dayvid VR Oliveira, George DC Cavalcanti,
    and Robert Sabourin. "FIRE-DES++: Enhanced online pruning of base
    classifiers for dynamic ensemble selection."
    Pattern Recognition 85 (2019): 149-160.
    """
```

**Core Methods**:
```python
def __init__(self, n_neighbors=7, knn_classifier='sklearn', **kwargs):
    """Initialize the KNNE classifier.

    Parameters
    ----------
    n_neighbors : int, default=7
        Number of neighbors to use by default for kneighbors queries.
    knn_classifier : str, default='sklearn'
        KNN implementation method ('knn' or 'faiss').
    **kwargs : dict
        Additional keyword arguments for the underlying KNN implementation.
    """

def fit(self, X, y):
    """Fit the KNNE model using X as training data and y as target values.

    Parameters
    ----------
    X : array-like of shape (n_samples, n_features)
        Training data.
    y : array-like of shape (n_samples,)
        Target values.

    Returns
    -------
    self : object
        Returns the instance itself.
    """

def kneighbors(self, X=None, n_neighbors=None, return_distance=True):
    """Find the K-neighbors of a point using KNNE.

    Parameters
    ----------
    X : array-like of shape (n_queries, n_features)
        The query point or points.
    n_neighbors : int, default=None
        Number of neighbors required for each sample.
    return_distance : bool, default=True
        Whether or not to return the distances.

    Returns
    -------
    neigh_dist : ndarray of shape (n_queries, n_neighbors)
        Array representing the lengths to points, only present if
        return_distance=True.
    neigh_ind : ndarray of shape (n_queries, n_neighbors)
        Indices of the nearest points in the population matrix.
    """

def predict(self, X):
    """Predict the class labels for the provided data.

    Parameters
    ----------
    X : array-like of shape (n_queries, n_features)
        Test samples.

    Returns
    -------
    y : ndarray of shape (n_queries,)
        Class labels for each data sample.
    """

def predict_proba(self, X):
    """Return probability estimates for the test data X.

    Parameters
    ----------
    X : array-like of shape (n_queries, n_features)
        Test samples.

    Returns
    -------
    p : ndarray of shape (n_queries, n_classes)
        The class probabilities of the input samples.
    """
def _set_knn_type(self):    
    """Set the KNN implementation method.

    Parameters
    ----------
    knn_classifier : str, default='sklearn'
        KNN implementation method ('knn' or 'faiss').
    """
def _organize_neighbors(self, dists, inds):
    """Organize the neighbors distances and indices for each class.

    Parameters
    ----------
    dists : ndarray of shape (n_queries, n_neighbors)
        Array representing the lengths to points.
    inds : ndarray of shape (n_queries, n_neighbors)
        Indices of the nearest points in the population matrix.

    Returns
    -------
    dists_per_class : list of shape = [n_classes]
        List of arrays, where each array contains the distances of the
        nearest neighbors for each class.
    inds_per_class : list of shape = [n_classes]
        List of arrays, where each array contains the indices of the
        nearest neighbors for each class.
    """
def _check_n_neighbors(self, n_neighbors): 
    """Check the number of neighbors.

    Parameters
    ----------
    n_neighbors : int
        Number of neighbors to use by default for kneighbors queries.

    Returns
    -------
    n_neighbors : int
        Number of neighbors to use by default for kneighbors queries.
    """
def _handle_n_neighbors(self, n_neighbors):
    """Handle the number of neighbors.

    Parameters
    ----------
    n_neighbors : int
        Number of neighbors to use by default for kneighbors queries.

    Returns
    -------
    n_neighbors : int
        Number of neighbors to use by default for kneighbors queries.
    """

```

**Parameter Description**:
- `n_neighbors` (int): Number of neighbors to use by default for kneighbors queries, default is 7
- `knn_classifier` (str): KNN implementation method ('knn' or 'faiss'), default is 'sklearn'  
- `**kwargs`: Additional keyword arguments for the underlying KNN implementation

#### 11. Utility Functions - Aggregation Methods

**Import Statement**:
```python
from deslib.util.aggregation import (
    majority_voting, weighted_majority_voting, majority_voting_rule,
    weighted_majority_voting_rule, get_weighted_votes, sum_votes_per_class,
    predict_proba_ensemble, aggregate_proba_ensemble_weighted,
    average_combiner, product_combiner, maximum_combiner, minimum_combiner,
    median_combiner, average_rule, product_rule, median_rule, maximum_rule,
    minimum_rule, _check_predictions, _get_ensemble_votes, _get_ensemble_probabilities
)
```

**Function**: Collection of aggregation functions for combining classifier outputs.

##### majority_voting(classifier_ensemble, X)
```python
def majority_voting(classifier_ensemble, X):
    """Apply the majority voting rule to predict the label of each sample in X.

    Parameters
    ----------
    classifier_ensemble : list of shape = [n_classifiers]
        Containing the ensemble of classifiers used in the
        aggregation scheme.

    X : array of shape (n_samples, n_features)
        The input data.

    Returns
    -------
    predicted_label : array of shape (n_samples)
        The label of each query sample predicted using the majority voting rule
    """
```

##### weighted_majority_voting(classifier_ensemble, weights, X)
```python
def weighted_majority_voting(classifier_ensemble, weights, X):
    """Apply the weighted majority voting rule to predict the label of each
    sample in X. The size of the weights vector should be equal to the size of
    the ensemble.

    Parameters
    ----------
    classifier_ensemble : list of shape = [n_classifiers]
        Containing the ensemble of classifiers used in the aggregation scheme.

    weights : array of shape (n_samples, n_classifiers)
              Weights associated to each base classifier for each sample

    X : array of shape (n_samples, n_features)
        The input data.

    Returns
    -------
    predicted_label : array of shape (n_samples)
        The label of each query sample predicted using the majority voting rule
    """
```

##### majority_voting_rule(votes)
```python
def majority_voting_rule(votes):
    """Apply the majority voting rule to the votes matrix.

    Parameters
    ----------
    votes : array of shape (n_samples, n_classifiers)
        The votes of each base classifier for each sample.

    Returns
    -------
    predicted_label : array of shape (n_samples)
        The predicted label for each sample using majority voting.
    """
```

##### weighted_majority_voting_rule(votes, weights, labels_set)
```python
def weighted_majority_voting_rule(votes, weights, labels_set=None):
    """Apply the weighted majority voting rule to the votes matrix.

    Parameters
    ----------
    votes : array of shape (n_samples, n_classifiers)
        The votes of each base classifier for each sample.
    weights : array of shape (n_samples, n_classifiers)
        The weights associated to each base classifier for each sample.
    labels_set : array of shape (n_classes)
        The set of class labels.

    Returns
    -------
    predicted_label : array of shape (n_samples)
        The predicted label for each sample using weighted majority voting.
    """
```

##### predict_proba_ensemble(classifier_ensemble, X, estimator_features)
```python
def predict_proba_ensemble(classifier_ensemble, X, estimator_features=None):
    """Get probability estimates from the ensemble of classifiers.

    Parameters
    ----------
    classifier_ensemble : list of classifiers
        The ensemble of classifiers.
    X : array of shape (n_samples, n_features)
        The input data.
    estimator_features : array of shape (n_classifiers, n_features)
        The features used by each classifier.

    Returns
    -------
    probabilities : array of shape (n_samples, n_classifiers, n_classes)
        The probability estimates from each classifier.
    """
```

##### average_combiner(classifier_ensemble, X)
```python
def average_combiner(classifier_ensemble, X):
    """Combine classifier outputs using the average rule.

    Parameters
    ----------
    classifier_ensemble : list of classifiers
        The ensemble of classifiers.
    X : array of shape (n_samples, n_features)
        The input data.

    Returns
    -------
    predicted_proba : array of shape (n_samples, n_classes)
        The combined probability estimates.
    """
```

##### product_combiner(classifier_ensemble, X)
```python
def product_combiner(classifier_ensemble, X):
    """Combine classifier outputs using the product rule.

    Parameters
    ----------
    classifier_ensemble : list of classifiers
        The ensemble of classifiers.
    X : array of shape (n_samples, n_features)
        The input data.

    Returns
    -------
    predicted_proba : array of shape (n_samples, n_classes)
        The combined probability estimates.
    """
```

##### get_weighted_votes(votes, weights, labels_set)
```python
def get_weighted_votes(votes, weights, labels_set=None):
    """Get weighted votes for each class.

    Parameters
    ----------
    votes : array of shape (n_samples, n_classifiers)
        Vote matrix from classifiers.
    weights : array of shape (n_samples, n_classifiers)
        Weight matrix for each classifier.
    labels_set : array of shape (n_classes)
        Set of class labels.

    Returns
    -------
    weighted_votes : array of shape (n_samples, n_classes)
        Weighted votes for each class.
    """
```

##### sum_votes_per_class(predictions, n_classes)
```python
def sum_votes_per_class(predictions, n_classes):
    """Sum votes per class from predictions.

    Parameters
    ----------
    predictions : array of shape (n_samples, n_classifiers)
        Prediction matrix from classifiers.
    n_classes : int
        Number of classes.

    Returns
    -------
    vote_counts : array of shape (n_samples, n_classes)
        Vote counts for each class.
    """
```

##### aggregate_proba_ensemble_weighted(ensemble_proba, weights)
```python
def aggregate_proba_ensemble_weighted(ensemble_proba, weights):
    """Aggregate weighted probabilities from ensemble.

    Parameters
    ----------
    ensemble_proba : array of shape (n_samples, n_classifiers, n_classes)
        Probability predictions from ensemble.
    weights : array of shape (n_samples, n_classifiers)
        Weights for each classifier.

    Returns
    -------
    aggregated_proba : array of shape (n_samples, n_classes)
        Weighted aggregated probabilities.
    """
```

##### maximum_combiner(classifier_ensemble, X)
```python
def maximum_combiner(classifier_ensemble, X):
    """Maximum probability combiner.

    Parameters
    ----------
    classifier_ensemble : list of classifiers
        Ensemble of trained classifiers.
    X : array of shape (n_samples, n_features)
        Test samples.

    Returns
    -------
    combined_proba : array of shape (n_samples, n_classes)
        Maximum combined probabilities.
    """
```

##### minimum_combiner(classifier_ensemble, X)
```python
def minimum_combiner(classifier_ensemble, X):
    """Minimum probability combiner.

    Parameters
    ----------
    classifier_ensemble : list of classifiers
        Ensemble of trained classifiers.
    X : array of shape (n_samples, n_features)
        Test samples.

    Returns
    -------
    combined_proba : array of shape (n_samples, n_classes)
        Minimum combined probabilities.
    """
```

##### median_combiner(classifier_ensemble, X)
```python
def median_combiner(classifier_ensemble, X):
    """Median probability combiner.

    Parameters
    ----------
    classifier_ensemble : list of classifiers
        Ensemble of trained classifiers.
    X : array of shape (n_samples, n_features)
        Test samples.

    Returns
    -------
    combined_proba : array of shape (n_samples, n_classes)
        Median combined probabilities.
    """
```

##### average_rule(predictions)
```python
def average_rule(predictions):
    """Average rule for probability combination.

    Parameters
    ----------
    predictions : array of shape (n_samples, n_classifiers, n_classes)
        Probability predictions from classifiers.

    Returns
    -------
    averaged_proba : array of shape (n_samples, n_classes)
        Averaged probabilities.
    """
```

##### product_rule(predictions)
```python
def product_rule(predictions):
    """Product rule for probability combination.

    Parameters
    ----------
    predictions : array of shape (n_samples, n_classifiers, n_classes)
        Probability predictions from classifiers.

    Returns
    -------
    product_proba : array of shape (n_samples, n_classes)
        Product combined probabilities.
    """
```

##### median_rule(predictions)
```python
def median_rule(predictions):
    """Median rule for probability combination.

    Parameters
    ----------
    predictions : array of shape (n_samples, n_classifiers, n_classes)
        Probability predictions from classifiers.

    Returns
    -------
    median_proba : array of shape (n_samples, n_classes)
        Median combined probabilities.
    """
```

##### maximum_rule(predictions)
```python
def maximum_rule(predictions):
    """Maximum rule for probability combination.

    Parameters
    ----------
    predictions : array of shape (n_samples, n_classifiers, n_classes)
        Probability predictions from classifiers.

    Returns
    -------
    maximum_proba : array of shape (n_samples, n_classes)
        Maximum combined probabilities.
    """
```

##### minimum_rule(predictions)
```python
def minimum_rule(predictions):
    """Minimum rule for probability combination.

    Parameters
    ----------
    predictions : array of shape (n_samples, n_classifiers, n_classes)
        Probability predictions from classifiers.

    Returns
    -------
    minimum_proba : array of shape (n_samples, n_classes)
        Minimum combined probabilities.
    """
```

##### _check_predictions(predictions)
```python
def _check_predictions(predictions):
    """Validate prediction arrays.

    Parameters
    ----------
    predictions : array-like
        Prediction arrays to validate.

    Raises
    ------
    ValueError
        If predictions are invalid.
    """
```

##### _get_ensemble_votes(classifier_ensemble, X)
```python
def _get_ensemble_votes(classifier_ensemble, X):
    """Get votes from ensemble classifiers.

    Parameters
    ----------
    classifier_ensemble : list of classifiers
        Ensemble of trained classifiers.
    X : array of shape (n_samples, n_features)
        Test samples.

    Returns
    -------
    votes : array of shape (n_samples, n_classifiers)
        Vote matrix from ensemble.
    """
```

##### _get_ensemble_probabilities(classifier_ensemble, X, estimator_features)
```python
def _get_ensemble_probabilities(classifier_ensemble, X,  estimator_features=None):
    """Get probabilities from ensemble classifiers.

    Parameters
    ----------
    classifier_ensemble : list of classifiers
        Ensemble of trained classifiers.
    X : array of shape (n_samples, n_features)
        Test samples.
    estimator_features : array-like
        Feature indices for each estimator.

    Returns
    -------
    probabilities : array of shape (n_samples, n_classifiers, n_classes)
        Probability matrix from ensemble.
    """
```

#### 12. Utility Functions - Diversity Measures

**Import Statement**:
```python
from deslib.util.diversity import (
    double_fault, Q_statistic, ratio_errors, disagreement_measure,
    agreement_measure, correlation_coefficient, compute_pairwise_diversity,
    negative_double_fault, _process_predictions
)
from deslib.util.diversity_batch import (
    double_fault, Q_statistic, ratio_errors, disagreement_measure,
    agreement_measure, correlation_coefficient, compute_pairwise_diversity
)
```

**Function**: Collection of diversity measures for evaluating classifier ensemble diversity.

##### double_fault(y, y_pred1, y_pred2)
```python
def double_fault(y, y_pred1, y_pred2):
    """Calculate the double fault diversity measure between two classifiers.
    
    The double fault measure represents the probability that both classifiers
    make an error on the same sample.

    Parameters
    ----------
    y : array of shape (n_samples)
        True class labels.
    y_pred1 : array of shape (n_samples)
        Predicted class labels from classifier 1.
    y_pred2 : array of shape (n_samples)
        Predicted class labels from classifier 2.

    Returns
    -------
    df : float
        The double fault measure between the two classifiers.
    """
```

##### Q_statistic(y, y_pred1, y_pred2)
```python
def Q_statistic(y, y_pred1, y_pred2):
    """Calculate the Q-statistic diversity measure between two classifiers.
    
    The Q-statistic measures the degree of agreement between two classifiers
    beyond what would be expected by chance.

    Parameters
    ----------
    y : array of shape (n_samples)
        True class labels.
    y_pred1 : array of shape (n_samples)
        Predicted class labels from classifier 1.
    y_pred2 : array of shape (n_samples)
        Predicted class labels from classifier 2.

    Returns
    -------
    Q : float
        The Q-statistic measure between the two classifiers.
    """
```

##### ratio_errors(y, y_pred1, y_pred2)
```python
def ratio_errors(y, y_pred1, y_pred2):
     """Calculates Ratio of errors diversity measure between a pair of
    classifiers. A higher value means that the base classifiers are less likely
    to make the same errors. The ratio must be maximized for a higher diversity

    Parameters
    ----------
    y : array of shape (n_samples,):
        class labels of each sample.

    y_pred1 : array of shape (n_samples,):
              predicted class labels by the classifier 1 for each sample.


    y_pred2 : array of shape (n_classifiers, n_samples):
              predicted class labels by the classifier 2 for each sample.

    Returns
    -------
    ratio : The q-statistic measure between two classifiers

    References
    ----------
    Aksela, Matti. "Comparison of classifier selection methods for improving
    committee performance."
    Multiple Classifier Systems (2003): 159-159.
    """
```

##### disagreement_measure(y, y_pred1, y_pred2)
```python
def disagreement_measure(y, y_pred1, y_pred2):
    """Calculates the disagreement measure between a pair of classifiers. This
        measure is calculated by the frequency that only one classifier makes the
        correct prediction.

        Parameters
        ----------
        y : array of shape (n_samples,):
            class labels of each sample.

        y_pred1 : array of shape (n_samples,):
                predicted class labels by the classifier 1 for each sample.


        y_pred2 : array of shape (n_classifiers, n_samples):
                predicted class labels by the classifier 2 for each sample.

        Returns
        -------
        disagreement : The frequency at which both classifiers disagrees
    """
```

##### agreement_measure(y, y_pred1, y_pred2)
```python
def agreement_measure(y, y_pred1, y_pred2):
    """Calculates the agreement measure between a pair of classifiers. This
    measure is calculated by the frequency that both classifiers either
    obtained the correct or incorrect prediction for any given sample

    Parameters
    ----------
    y : array of shape (n_samples):
        class labels of each sample.

    y_pred1 : array of shape (n_samples):
              predicted class labels by the classifier 1 for each sample.

    y_pred2 : array of shape (n_samples):
              predicted class labels by the classifier 2 for each sample.

    Returns
    -------
    agreement : The frequency at which both classifiers agrees
    """
```

##### correlation_coefficient(y, y_pred1, y_pred2)
```python
def correlation_coefficient(y, y_pred1, y_pred2):
    """Calculates the correlation  between two classifiers using oracle
    outputs. Coefficient is a value in a range [-1, 1].

    Parameters
    ----------
    y : array of shape (n_samples):
        class labels of each sample.

    y_pred1 : array of shape (n_samples):
              predicted class labels by the classifier 1 for each sample.

    y_pred2 : array of shape (n_samples):
              predicted class labels by the classifier 2 for each sample.

    Returns
    -------
    rho : The correlation coefficient measured between two classifiers
    """
```

##### compute_pairwise_diversity(targets, prediction_matrix, diversity_func)
```python
def compute_pairwise_diversity(targets, prediction_matrix, diversity_func):
    """Computes the pairwise diversity matrix.

     Parameters
     ----------
     targets : array of shape (n_samples):
        Class labels of each sample in X.

     prediction_matrix : array of shape (n_samples, n_classifiers):
        Predicted class labels for each classifier in the pool

     diversity_func : Function
        Function used to estimate the pairwise diversity

     Returns
     -------
     diversity : array of shape = [n_classifiers]
        The average pairwise diversity matrix calculated for the pool of
        classifiers

     """
```

##### negative_double_fault(y, y_pred1, y_pred2)
```python
def negative_double_fault(y, y_pred1, y_pred2):
    """The negative of the double fault measure. This measure should be
    maximized for a higher diversity.

    Parameters
    ----------
    y : array of shape (n_samples):
        class labels of each sample.

    y_pred1 : array of shape (n_samples):
              predicted class labels by the classifier 1 for each sample.

    y_pred2 : array of shape (n_samples):
              predicted class labels by the classifier 2 for each sample.

    Returns
    -------
    df : The negative double fault measure between two classifiers

    References
    ----------
    Giacinto, Giorgio, and Fabio Roli. "Design of effective neural network
    ensembles for image classification purposes."
    Image and Vision Computing 19.9 (2001): 699-707.
    """
```

##### _process_predictions(y, y_pred1, y_pred2)
```python
def _process_predictions(y, y_pred1, y_pred2):
    """Pre-process the predictions of a pair of base classifiers for the
    computation of the diversity measures

    Parameters
    ----------
    y : array of shape (n_samples,):
        class labels of each sample.

    y_pred1 : array of shape (n_samples,):
              predicted class labels by the classifier 1 for each sample.


    y_pred2 : array of shape (n_classifiers, n_samples):
              predicted class labels by the classifier 2 for each sample.

    Returns
    -------
    N00 : Array of shape (n_samples,)
        Percentage of samples that both classifiers predict the wrong label

    N10 : Array of shape (n_samples,)
        Percentage of samples that only classifier 2 predicts the wrong label

    N01 : Array of shape (n_samples,)
        Percentage of samples that only classifier 1 predicts the wrong label

    N11 : Array of shape (n_samples,)
        Percentage of samples that both classifiers predict the correct label
    """
```

**Note**: All diversity functions have batch processing versions available in `diversity_batch.py` module.

#### 13. Utility Functions - Probability Functions

**Import Statement**:
```python
from deslib.util.prob_functions import (
    exponential_func, log_func, entropy_func, ccprmod, 
    min_difference, softmax
)
```

**Function**: Collection of probability-related utility functions for competence estimation.

##### exponential_func(n_classes, support_correct)
```python
def exponential_func(n_classes, support_correct):
    """Calculate the exponential function based on the support obtained by
    the base classifier for the correct class label.

    Parameters
    ----------
    n_classes : int
        The number of classes in the problem

    support_correct: array of shape (n_samples)
        containing the supports obtained by the base classifier for the correct
        class

    Returns
    -------
    C_src : array of shape (n_samples)
        Representing the classifier competences at each data point
    """
```

##### log_func(n_classes, support_correct)
```python
def log_func(n_classes, support_correct):
    """Calculate the logarithm in the support obtained by
    the base classifier.

    Parameters
    ----------
    n_classes : int
        The number of classes in the problem

    support_correct: array of shape (n_samples)
        Containing the supports obtained by the base classifier for the correct
        class

    Returns
    -------
    C_src : array of shape (n_samples)
            representing the classifier competences at each data point

    References
    ----------
    T.Woloszynski, M. Kurzynski, A measure of competence based on randomized
    reference classifier for dynamic ensemble selection, in: International
    Conference on Pattern Recognition (ICPR), 2010, pp. 4194–4197.
    """
```

##### entropy_func(n_classes, supports, is_correct)
```python
def entropy_func(n_classes, supports, is_correct):
    """Calculate the entropy in the support obtained by
    the base classifier. The value of the source competence is inverse
    proportional to the normalized entropy of its supports vector and the sign
    of competence is simply determined  by the correct/incorrect classification

    Parameters
    ----------
    n_classes : int
        The number of classes in the problem

    supports: array of shape (n_samples, n_classes)
        Containing the supports obtained by the base classifier for each class.

    is_correct: array of shape (n_samples)
        Array with 1 whether the base classifier predicted the correct label
        and -1 otherwise

    Returns
    -------
    C_src : array of shape (n_samples)
        Representing the classifier competences at each data point

    References
    ----------
    B. Antosik, M. Kurzynski, New measures of classifier competence –
    heuristics and application to the design of multiple classifier systems.,
    in: Computer recognition systems 4., 2011, pp. 197–206.
    """
```

##### ccprmod(supports, idx_correct_label, B=1.0)
```python
def ccprmod(supports, idx_correct_label, B=20):
    """Python implementation of the ccprmod.m (Classifier competence based on
    probabilistic modelling)
    function. Matlab code is available at:
    http://www.mathworks.com/matlabcentral/mlc-downloads/downloads/submissions/28391/versions/6/previews/ccprmod.m/index.html

    Parameters
    ----------
    supports: array of shape (n_samples, n_classes)
        Containing the supports obtained by the base classifier for each class.

    idx_correct_label: array of shape (n_samples)
                       containing the index of the correct class.

    B : int (Default = 20)
        number of points used in the calculation of the competence, higher
        values result in a more accurate estimation.

    Returns
    -------
    C_src : array of shape (n_samples)
            representing the classifier competences at each data point

    Examples
    --------
    >>> supports = [[0.3, 0.6, 0.1],[1.0/3, 1.0/3, 1.0/3]]
    >>> idx_correct_label = [1,0]
    >>> ccprmod(supports,idx_correct_label)
    ans = [0.784953394056843, 0.332872292262951]

    References
    ----------
    T.Woloszynski, M. Kurzynski, A probabilistic model of classifier competence
    for dynamic ensemble selection,
    Pattern Recognition 44 (2011) 2656–2668.
    """
```

##### min_difference(supports, idx_correct_label)
```python
def min_difference(supports, idx_correct_label):
   """The minimum difference between the supports obtained for the correct
    class and the vector of class supports. The value of the source competence
    is negative if the sample is misclassified and positive otherwise.

    Parameters
    ----------
    supports: array of shape (n_samples, n_classes)
        Containing the supports obtained by the base classifier for each class

    idx_correct_label: array of shape (n_samples)
        Containing the index of the correct class

    Returns
    -------
    C_src : array of shape (n_samples)
        Representing the classifier competences at each data point

    References
    ----------
    B. Antosik, M. Kurzynski, New measures of classifier competence –
    heuristics and application to the design of multiple classifier systems.,
    in: Computer recognition systems 4., 2011, pp. 197–206.
    """
```

##### softmax(w, theta=1.0)
```python
def softmax(w, theta=1.0):
   """Takes an vector w of S N-element and returns a vectors where each column
    of the vector sums to 1, with elements exponentially proportional to the
    respective elements in N.

    Parameters
    ----------
    w : array of shape = [N,  M]

    theta : float (default = 1.0)
            used as a multiplier  prior to exponentiation.

    Returns
    -------
    dist : array of shape = [N, M]
        Which the sum of each row sums to 1 and the elements are exponentially
        proportional to the respective elements in N

    """
```

#### 14. Utility Functions - Dataset Generation

**Import Statement**:
```python
from deslib.util.datasets import (
    make_P2, make_circle_square, make_banana, make_banana2, make_xor
)
```

**Function**: Collection of synthetic dataset generation functions for testing and benchmarking.

##### make_P2(size_classes, random_state=None)
```python
def make_P2(size_classes, random_state=None):
    """Generate the P2 Dataset:

    The P2 is a two-class problem, presented by Valentini[1], in which each
    class is defined in multiple decision regions delimited by polynomial
    and trigonometric functions (E1, E2, E3 and E4):

    .. math:: \\begin{eqnarray}
        \\label{eq:problem1}
        E1(x) = sin(x) + 5 \\\\
        \\label{eq:problem2}
        E2(x) = (x - 2)^{2} + 1 \\\\
        \\label{eq:problem3}
        E3(x) = -0.1 \\cdot x^{2} + 0.6sin(4x) + 8 \\\\
        \\label{eq:problem4}
        E4(x) = \\frac{(x - 10)^{2}}{2} + 7.902
        \\end{eqnarray}

    Parameters
    ----------
    size_classes : list with the number of samples for each class.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    returns
    -------
    X : array of shape = [size_classes, 2]
        The generated data points.

    y : array of shape = [size_classes]
        Class labels associated with each class.

    References
    ----------
    G. Valentini, An experimental bias-variance analysis of svm ensembles
    based on resampling techniques, IEEE Transactions on Systems, Man,
    and Cybernetics, Part B 35 (2005) 1252–1271.

    """
```

##### make_circle_square(size_classes, random_state=None)
```python
def make_circle_square(size_classes, random_state=None):
   """Generate the circle square dataset.

    Parameters
    ----------
    size_classes : list with the number of samples for each class.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    returns
    -------
    X : array of shape = [size_classes, 2]
        The generated data points.

    y : array of shape = [size_classes]
        Class labels associated with each class.

    References
    ----------
    P. Henniges, E. Granger, R. Sabourin, Factors of overtraining
    with fuzzy artmap neural networks, International Joint Conference
    on Neural Networks (2005) 1075–1080.

    """
```

##### make_banana(size_classes, na, random_state=None)
```python
def make_banana(size_classes, na=0.1, random_state=None):
    """Generate the banana-shaped synthetic dataset.
    
    Creates a dataset with banana-shaped class distributions.

    Parameters
    ----------
    size_classes : array of shape (n_classes)
        Number of samples for each class.
    na : float
        Parameter controlling the banana shape curvature.
    random_state : int, RandomState instance or None, default=None
        Random state for reproducible results.

    Returns
    -------
    X : array of shape (n_samples, 2)
        The generated samples.
    y : array of shape (n_samples)
        The integer labels for class membership of each sample.
    """
```

##### make_banana2(size_classes, sigma, random_state=None)
```python
def make_banana2(size_classes, sigma=1, random_state=None):
    """Generate the banana2 synthetic dataset.
    
    Creates a second variant of banana-shaped class distributions.

    Parameters
    ----------
    size_classes : array of shape (n_classes)
        Number of samples for each class.
    sigma : float
        Standard deviation parameter for the distributions.
    random_state : int, RandomState instance or None, default=None
        Random state for reproducible results.

    Returns
    -------
    X : array of shape (n_samples, 2)
        The generated samples.
    y : array of shape (n_samples)
        The integer labels for class membership of each sample.
    """
```

##### make_xor(n_samples, random_state=None)
```python
def make_xor(n_samples, random_state=None):
    """Generate the XOR synthetic dataset.
    
    Creates a dataset with XOR-like class distributions that are
    not linearly separable.

    Parameters
    ----------
    n_samples : int
        Total number of samples to generate.
    random_state : int, RandomState instance or None, default=None
        Random state for reproducible results.

    Returns
    -------
    X : array of shape (n_samples, 2)
        The generated samples.
    y : array of shape (n_samples)
        The integer labels for class membership of each sample.
    """
```

#### 15. Utility Functions - Instance Hardness

**Import Statement**:
```python
from deslib.util.instance_hardness import hardness_region_competence, kdn_score
```

**Function**: Functions for calculating instance hardness and competence region analysis.

##### hardness_region_competence(neighbors_idx, labels, safe_k)
```python
def hardness_region_competence(neighbors_idx, labels, safe_k):
    """Calculate the hardness level of the region of competence.
    
    The hardness level is calculated based on the number of samples
    in the region of competence that have different class labels.

    Parameters
    ----------
    neighbors_idx : array of shape (n_samples, n_neighbors)
        Indices of the k nearest neighbors for each sample.
    labels : array of shape (n_samples)
        Class labels of the samples in DSEL.
    safe_k : int
        Number of neighbors used to estimate the hardness level.

    Returns
    -------
    hardness : array of shape (n_samples)
        The hardness level of each sample's region of competence.
    """
```

##### kdn_score(X, y, k)
```python
def kdn_score(X, y, k):
    """Calculate k-disagreeing neighbors (KDN) score for instance hardness.
    
    The KDN score measures the proportion of k nearest neighbors that
    have different class labels than the query sample.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        The input data.
    y : array of shape (n_samples)
        Class labels of each sample.
    k : int
        Number of nearest neighbors to consider.

    Returns
    -------
    kdn_scores : array of shape (n_samples)
        The KDN score for each sample.
    """
```

#### 16. Utility Functions - Dynamic Frienemy Pruning

**Function**: Functions for dynamic frienemy pruning (DFP) to improve classifier selection.

##### DFP Functions
```python
def frienemy_pruning(X_query, X_dsel, y_dsel, ensemble, k):
    """Apply frienemy pruning to the ensemble."""

def frienemy_pruning_preprocessed(neighbors, y_val, hit_miss):
    """Apply frienemy pruning with preprocessed data."""
```

#### 17. BaseDS Class - Base Dynamic Selection

**Import Statement**:
```python
from deslib.base import BaseDS
```

**Function**: Base class for dynamic classifier selection (DCS) and dynamic ensemble selection (DES) methods. All DCS and DES techniques inherit from this class.

**Class Definition**:
```python
class BaseDS(BaseEstimator, ClassifierMixin):
    """Base class for a dynamic classifier selection (dcs) and
       dynamic ensemble selection (des) methods.

    All DCS and DES techniques should inherit from this class.

    Warning: This class should not be used directly.
    Use derived classes instead.
    """
    __metaclass__ = ABCMeta
```

**Core Methods**:
```python
@abstractmethod
def __init__(self, pool_classifiers=None, k=7, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, needs_proba=False,
             random_state=None, knn_classifier='knn',
             knn_metric='minkowski', DSEL_perc=0.5, knne=False, n_jobs=-1,
             voting=None):
    """Initialize the base DS model.
    
    Parameters
    ----------
    pool_classifiers : list, default=None
        List of base classifiers.
    k : int, default=7
        Number of neighbors.
    DFP : bool, default=False
        Whether to enable dynamic frienemy pruning.
    with_IH : bool, default=False
        Whether to use instance hardness.
    safe_k : int, default=None
        Number of safe neighbors.
    IH_rate : float, default=0.30
        Instance hardness threshold.
    needs_proba : bool, default=False
        Whether probabilities are needed.
    random_state : int, default=None
        Random seed.
    knn_classifier : str, default='knn'
        KNN implementation.
    knn_metric : str, default='minkowski'
        Distance metric.
    DSEL_perc : float, default=0.5
        Proportion of DSEL data.
    knne : bool, default=False
        Whether to use K-Nearest Neighbor Equality.
    n_jobs : int, default=-1
        Number of parallel jobs.
    voting : str, default=None
        Voting method.
    """

def fit(self, X, y):
    """Prepare the DS model by setting the KNN algorithm and
    pre-processing the information required to apply the DS
    methods

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        The input data.

    y : array of shape (n_samples)
        class labels of each example in X.

    Returns
    -------
    self
    """

def get_competence_region(self, query, k=None):
    """Compute the region of competence of the query sample
    using the data belonging to DSEL.

    Parameters
    ----------
    query : array of shape (n_samples, n_features)
            The test examples.

    k : int (Default = self.k)
        The number of neighbors used to in the region of competence.

    Returns
    -------
    dists : array of shape (n_samples, k)
            The distances between the query and each sample in the region
            of competence. The vector is ordered in an ascending fashion.

    idx : array of shape (n_samples, k)
          Indices of the instances belonging to the region of competence of
          the given query sample.
    """

@abstractmethod
def estimate_competence(self, competence_region, distances=None,
                        predictions=None):
    """estimate the competence of each base classifier :math:`c_{i}`
    the classification of the query sample :math:`\\mathbf{x}`.
    Returns an array containing the level of competence estimated
    for each base classifier. The size of the vector is equals to
    the size of the generated_pool of classifiers.

    Parameters
    ----------
    competence_region : array of shape (n_samples, n_neighbors)
                Indices of the k nearest neighbors according for each
                test sample.

    distances : array of shape (n_samples, n_neighbors)
                Distances of the k nearest neighbors according for each
                test sample.

    predictions : array of shape (n_samples, n_classifiers)
                  Predictions of the base classifiers for all test examples
    Returns
    -------
    competences : array (n_classifiers) containing the competence level
                  estimated for each base classifier
    """

@abstractmethod
def select(self, competences):
    """Select the most competent classifier for
    the classification of the query sample x.
    The most competent classifier (dcs) or an ensemble
    with the most competent classifiers (des) is returned

    Parameters
    ----------
    competences : array of shape (n_samples, n_classifiers)
                  The estimated competence level of each base classifier
                  for test example

    Returns
    -------
    selected_classifiers : array containing the selected base classifiers
                           for each test sample
    """

@abstractmethod
def classify_with_ds(self, predictions,  probabilities=None,
                         neighbors=None, distances=None, DFP_mask=None):
    """Predicts the label of the corresponding query sample.

    Parameters
    ----------
    predictions : array of shape (n_samples, n_classifiers)
        Predictions of the base classifiers for all test examples.
    probabilities : array of shape (n_samples, n_classifiers, n_classes)
        Probabilities estimates of each base classifier for all test examples.
    neighbors : array of shape (n_samples, n_neighbors)
        Indices of the k nearest neighbors.
    distances : array of shape (n_samples, n_neighbors)
        Distances from the k nearest neighbors to the query.
    DFP_mask : array of shape (n_samples, n_classifiers)
        Mask containing 1 for the selected base classifier and 0 otherwise.

    Returns
    -------
    predicted_label : array of shape (n_samples)
        The predicted label for each query sample.
    """

@abstractmethod
def predict_proba_with_ds(self, predictions, probabilities, neighbors=None, distances=None, DFP_mask=None):
    """Predicts the posterior probabilities of the corresponding query sample.

    Parameters
    ----------
    predictions : array of shape (n_samples, n_classifiers)
        Predictions of the base classifiers for all test examples.
    probabilities : array of shape (n_samples, n_classifiers, n_classes)
        Probabilities estimates of each base classifier for all test examples.
    neighbors : array of shape (n_samples, n_neighbors)
        Indices of the k nearest neighbors.
    distances : array of shape (n_samples, n_neighbors)
        Distances from the k nearest neighbors to the query.
    DFP_mask : array of shape (n_samples, n_classifiers)
        Mask containing 1 for the selected base classifier and 0 otherwise.

    Returns
    -------
    predicted_proba : array of shape (n_samples, n_classes)
        Posterior probabilities estimates for each test example.
    """

def predict(self, X):
    """Predict the class label for each sample in X.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        The input data.

    Returns
    -------
    predicted_labels : array of shape (n_samples)
        Class labels for each data sample.
    """

def predict_proba(self, X):
    """Estimates the posterior probabilities for sample in X.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        The input data.

    Returns
    -------
    predicted_proba : array of shape (n_samples, n_classes)
        Posterior probabilities for each class.
    """

@staticmethod
def _all_classifier_agree(predictions):
    """Check whether there is a difference in opinion among the classifiers
    in the generated_pool.

    Parameters
    ----------
    predictions : array of shape (n_samples, n_classifiers)
                  Predictions of the base classifiers for the test examples

    Returns
    -------
    array of shape (classes)
        containing True if all classifiers in the generated_pool agrees
        on the same label, otherwise False.
    """

def _check_predict(self, X):
    """Check if the DS model is fitted and validate input data.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        The input data.

    Returns
    -------
    X : array of shape (n_samples, n_features)
        Validated input data.
    """

def _preprocess_predictions(self, X, req_proba):
    """Get predictions and probabilities from base classifiers.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        The input data.
    req_proba : bool
        Whether probability estimates are required.

    Returns
    -------
    base_predictions : array of shape (n_samples, n_classifiers)
        Predictions from base classifiers.
    base_probabilities : array of shape (n_samples, n_classifiers, n_classes) or None
        Probability estimates from base classifiers.
    """

def _split_agreement(self, base_predictions):
    """Split samples based on classifier agreement.

    Parameters
    ----------
    base_predictions : array of shape (n_samples, n_classifiers)
        Predictions from base classifiers.

    Returns
    -------
    ind_disagreement : array
        Indices of samples where classifiers disagree.
    ind_all_agree : array
        Indices of samples where all classifiers agree.
    """

def _predict_base(self, X):
    """Get the predictions of each base classifier in the pool for all samples in X.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        The input data.

    Returns
    -------
    predictions : array of shape (n_samples, n_classifiers)
        Predictions of each base classifier for all samples.
    """

def _predict_proba_base(self, X):
    """Get the predictions (probabilities) of each base classifier in the pool for all samples in X.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        The input data.

    Returns
    -------
    probabilities : array of shape (n_samples, n_classifiers, n_classes)
        Probability estimates of each base classifier for all samples.
    """

def _validate_parameters(self):
    """Verify if the input parameters are correct (pool and k).
    Raises an error if k < 1 or pool is not fitted.
    """

def _validate_pool_classifiers(self):
    """Check the estimator and the n_estimator attribute.
    Set the base_estimator_ attribute.
    """

def _check_predict_proba(self):
    """Checks if each base classifier in the pool implements the predict_proba method.
    """

def _check_base_classifier_fitted(self):
    """Checks if each base classifier in the pool is fitted.
    """

def _fit_pool_classifiers(self, X, y):
    """Fit the pool of classifiers using bagging if pool is None.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Training data.
    y : array of shape (n_samples)
        Target values.

    Returns
    -------
    X_dsel : array
        DSEL dataset features.
    y_dsel : array
        DSEL dataset labels.
    """

def _set_dsel(self, X, y):
    """Pre-Process the input X and y data into the dynamic selection dataset (DSEL).

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Training data.
    y : array of shape (n_samples)
        Target values.
    """

def _set_region_of_competence_algorithm(self, X):
    """Set up the KNN algorithm for region of competence estimation.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Training data.
    """

def _preprocess_dsel(self):
    """Compute the prediction of each base classifier for
    all samples in DSEL. Used to speed-up the test phase, by
    not requiring to re-classify training samples during test.

    Returns
    -------
    DSEL_processed_ : array of shape (n_samples, n_classifiers).
                        Each element indicates whether the base classifier
                        predicted the correct label for the corresponding
                        sample (True), otherwise (False).

    BKS_DSEL_ : array of shape (n_samples, n_classifiers)
                Predicted labels of each base classifier for all samples
                in DSEL.
    """

def _get_DFP_mask(self, neighbors):
    """Get the Dynamic Frienemy Pruning mask.

    Parameters
    ----------
    neighbors : array of shape (n_samples, n_neighbors)
        Indices of the k nearest neighbors.

    Returns
    -------
    DFP_mask : array of shape (n_samples, n_classifiers)
        Mask for dynamic frienemy pruning.
    """
```

**Parameter Description**:
- `pool_classifiers` (list, default=None): List of base classifiers
- `k` (int, default=7): Number of neighbors
- `DFP` (bool, default=False): Whether to enable dynamic frienemy pruning
- `with_IH` (bool, default=False): Whether to use instance hardness
- `safe_k` (int, default=None): Number of safe neighbors
- `IH_rate` (float, default=0.30): Instance hardness threshold
- `needs_proba` (bool, default=False): Whether probabilities are needed
- `random_state` (int, RandomState instance or None, default=None): Random seed
- `knn_classifier` ({'knn', 'faiss', None}, default='knn'): KNN implementation
- `knn_metric` ({'minkowski', 'cosine', 'mahalanobis'}, default='minkowski'): Distance metric
- `DSEL_perc` (float, default=0.5): Proportion of DSEL data
- `knne` (bool, default=False): Whether to use K-Nearest Neighbor Equality
- `n_jobs` (int, default=-1): Number of parallel jobs
- `voting` (str, default=None): Voting method

#### 18. APosteriori Class - Dynamic Classifier Selection

**Import Statement**:
```python
from deslib.dcs.a_posteriori import APosteriori
```

**Function**: A Posteriori dynamic classifier selection algorithm that selects classifiers based on their local performance in the neighborhood of test samples.

**Class Definition**:
```python
class APosteriori(BaseDCS):
    """A Posteriori Dynamic classifier selection.

    The A Posteriori method uses the probability of correct classification of a
    given base classifier :math:`c_{i}` for each neighbor :math:`x_{k}` with
    respect to a single class. Consider a classifier :math:`c_{i}` that assigns
    a test sample to class :math:`w_{l}`. Then, only the samples belonging to
    class :math:`w_{l}` are taken into account during the competence level
    estimates. Base classifiers with a higher probability of correct
    classification have a higher competence level. Moreover, the method also
    weights the influence of each neighbor :math:`x_{k}` according to its
    Euclidean distance to the query sample. The closest neighbors have a higher
    influence on the competence level estimate. In cases where no sample in the
    region of competence belongs to the predicted class, :math:`w_{l}`, the
    competence level estimate of the base classifier is equal to zero.

    A single classifier is selected only if its competence level is
    significantly higher than that of the other base classifiers in the pool
    (higher than a pre-defined threshold). Otherwise, all classifiers in the
    pool are combined using the majority voting rule. The selection methodology
    can be modified by modifying the hyper-parameter selection_method.

    Parameters
    ----------
    pool_classifiers : list of classifiers (Default = None)
        The generated_pool of classifiers trained for the corresponding
        classification problem. Each base classifiers should support the method
        "predict" and "predict_proba". If None, then the pool of classifiers is
        a bagging classifier.

    k : int (Default = 7)
        Number of neighbors used to estimate the competence of the base
        classifiers.

    DFP : Boolean (Default = False)
        Determines if the dynamic frienemy pruning is applied.

    with_IH : Boolean (Default = False)
        Whether the hardness level of the region of competence is used to
        decide between using the DS algorithm or the KNN for classification of
        a given query sample.

    safe_k : int (default = None)
        The size of the indecision region.

    IH_rate : float (default = 0.3)
        Hardness threshold. If the hardness level of the competence region is
        lower than the IH_rate the KNN classifier is used. Otherwise, the DS
        algorithm is used for classification.

    selection_method : String (Default = "best")
        Determines which method is used to select the base classifier after
        the competences are estimated.

    diff_thresh : float (Default = 0.1)
        Threshold to measure the difference between the competence level of the
        base classifiers for the random and diff selection schemes. If the
        difference is lower than the threshold, their performance are
        considered equivalent.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    knn_classifier : {'knn', 'faiss', None} (Default = 'knn')
         The algorithm used to estimate the region of competence:

         - 'knn' will use :class:`KNeighborsClassifier` from sklearn
          :class:`KNNE` available on `deslib.utils.knne`

         - 'faiss' will use Facebook's Faiss similarity search through the
           class :class:`FaissKNNClassifier`

         - None, will use sklearn :class:`KNeighborsClassifier`.

    knn_metric : {'minkowski', 'cosine', 'mahalanobis'} (Default = 'minkowski')
        The metric used by the k-NN classifier to estimate distances.

        - 'minkowski' will use minkowski distance.

        - 'cosine' will use the cosine distance.

        - 'mahalanobis' will use the mahalonibis distance.

    knne : bool (Default=False)
        Whether to use K-Nearest Neighbor Equality (KNNE) for the region
        of competence estimation.

    DSEL_perc : float (Default = 0.5)
        Percentage of the input data used to fit DSEL.
        Note: This parameter is only used if the pool of classifier is None or
        unfitted.

    n_jobs : int, default=-1
        The number of parallel jobs to run. None means 1 unless in
        a joblib.parallel_backend context. -1 means using all processors.
        Doesn’t affect fit method.

    References
    ----------
    G. Giacinto and F. Roli, Methods for Dynamic Classifier Selection
    10th Int. Conf. on Image Anal. and Proc., Venice, Italy (1999), 659-664.

    Ko, Albert HR, Robert Sabourin, and Alceu Souza Britto Jr. "From dynamic
    classifier selection to dynamic ensemble selection."
    Pattern Recognition 41.5 (2008): 1718-1731.

    Britto, Alceu S., Robert Sabourin, and Luiz ES Oliveira. "Dynamic selection
    of classifiers—a comprehensive review."
    Pattern Recognition 47.11 (2014): 3665-3680.

    R. M. O. Cruz, R. Sabourin, and G. D. Cavalcanti, “Dynamic classifier
    selection: Recent advances and perspectives,”
    Information Fusion, vol. 41, pp. 195 – 216, 2018.

    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=7, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, selection_method='diff',
             diff_thresh=0.1, random_state=None, knn_classifier='knn',
             knn_metric='minkowski', knne=False, DSEL_perc=0.5, n_jobs=-1):
    """Initialize the A Posteriori classifier."""

def fit(self, X, y):
    """Train the A Posteriori classifier.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Training data.
    y : array of shape (n_samples)
        Target values.

    Returns
    -------
    self : object
        Returns the instance itself.
    """

def estimate_competence(self, competence_region, distances, predictions=None):
    """Estimate competence based on local performance.

    Parameters
    ----------
    competence_region : array of shape (n_samples, n_neighbors)
        Indices of samples in the competence region.
    distances : array of shape (n_samples, n_neighbors)
        Distances to the neighbors.
    predictions : array of shape (n_samples, n_classifiers)
        Predictions from base classifiers.

    Returns
    -------
    competences : array of shape (n_samples, n_classifiers)
        Competence estimates for each classifier.
    """
```

**Parameter Description**:
- `pool_classifiers`: List of classifier pools
- `k` (int): Number of neighbors in the region, default is 7
- `DFP` (bool): Whether to enable dynamic frienemy pruning, default is False
- `with_IH` (bool): Whether to use instance hardness, default is False
- `safe_k` (int): Number of safe neighbors, default is None
- `IH_rate` (float): Instance hardness threshold, default is 0.30
- `selection_method` (str): Selection method ('diff', 'best', 'random'), default is 'diff'
- `diff_thresh` (float): Difference threshold, default is 0.1
- `random_state` (int): Random seed, default is None
- `knn_classifier` (str): KNN implementation ('knn' or 'faiss'), default is 'knn'
- `knn_metric` (str): Distance metric, default is 'minkowski'
- `knne` (bool): Whether to use K-Nearest Neighbor Equality, default is False
- `DSEL_perc` (float): Proportion of DSEL data, default is 0.5
- `n_jobs` (int): Number of parallel jobs, default is -1

#### 19. APriori Class - Dynamic Classifier Selection

**Import Statement**:
```python
from deslib.dcs.a_priori import APriori
```

**Function**: A Priori dynamic classifier selection algorithm that uses prior knowledge about classifier performance.

**Class Definition**:
```python
class APriori(BaseDCS):
    """A Priori dynamic classifier selection.

    The A Priori method uses the probability of correct classification of a
    given base classifier :math:`c_{i}` for each neighbor :math:`x_{k}` for the
    competence level estimation. Base classifiers with a higher probability of
    correct classification have a higher competence level. Moreover, the method
    also weights the influence of each neighbor :math:`x_{k}` according to its
    Euclidean distance to the query sample. The closest neighbors have a higher
    influence on the competence level estimate.

    A single classifier is selected only if its competence level is
    significantly higher than that of the other base classifiers in the pool
    (higher than a pre-defined threshold). Otherwise, all classifiers i the
    pool are combined using the majority voting rule.

    Parameters
    ----------
    pool_classifiers : list of classifiers (Default = None)
        The generated_pool of classifiers trained for the corresponding
        classification problem. Each base classifiers should support the method
        "predict" and "predict_proba". If None, then the pool of classifiers is
        a bagging classifier.

    k : int (Default = 7)
        Number of neighbors used to estimate the competence of the base
        classifiers.

    DFP : Boolean (Default = False)
        Determines if the dynamic frienemy pruning is applied.

    with_IH : Boolean (Default = False)
        Whether the hardness level of the region of competence is used to
        decide between using the DS algorithm or the KNN for classification of
        a given query sample.

    safe_k : int (default = None)
        The size of the indecision region.

    IH_rate : float (default = 0.3)
        Hardness threshold. If the hardness level of the competence region is
        lower than the IH_rate the KNN classifier is used. Otherwise, the DS

    selection_method : String (Default = "best")
        Determines which method is used to select the base classifier after
        the competences are estimated.

    diff_thresh : float (Default = 0.1)
        Threshold to measure the difference between the competence level of the
        base classifiers for the random and diff selection schemes. If the
        difference is lower than the threshold, their performance are
        considered equivalent.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    knn_classifier : {'knn', 'faiss', None} (Default = 'knn')
         The algorithm used to estimate the region of competence:

         - 'knn' will use :class:`KNeighborsClassifier` from sklearn
          :class:`KNNE` available on `deslib.utils.knne`

         - 'faiss' will use Facebook's Faiss similarity search through the
           class :class:`FaissKNNClassifier`

         - None, will use sklearn :class:`KNeighborsClassifier`.

    knn_metric : {'minkowski', 'cosine', 'mahalanobis'} (Default = 'minkowski')
        The metric used by the k-NN classifier to estimate distances.

        - 'minkowski' will use minkowski distance.

        - 'cosine' will use the cosine distance.

        - 'mahalanobis' will use the mahalonibis distance.

    knne : bool (Default=False)
        Whether to use K-Nearest Neighbor Equality (KNNE) for the region
        of competence estimation.

    DSEL_perc : float (Default = 0.5)
        Percentage of the input data used to fit DSEL.
        Note: This parameter is only used if the pool of classifier is None or
        unfitted.

    n_jobs : int, default=-1
        The number of parallel jobs to run. None means 1 unless in
        a joblib.parallel_backend context. -1 means using all processors.
        Doesn’t affect fit method.

    References
    ----------
    G. Giacinto and F. Roli, Methods for Dynamic Classifier Selection
    10th Int. Conf. on Image Anal. and Proc., Venice, Italy (1999), 659-664.

    Ko, Albert HR, Robert Sabourin, and Alceu Souza Britto Jr. "From dynamic
    classifier selection to dynamic ensemble selection."
    Pattern Recognition 41.5 (2008): 1718-1731.

    Britto, Alceu S., Robert Sabourin, and Luiz ES Oliveira. "Dynamic selection
    of classifiers—a comprehensive review."
    Pattern Recognition 47.11 (2014): 3665-3680.

    R. M. O. Cruz, R. Sabourin, and G. D. Cavalcanti, “Dynamic classifier
    selection: Recent advances and perspectives,”
    Information Fusion, vol. 41, pp. 195 – 216, 2018.

    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=7, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, selection_method='diff',
             diff_thresh=0.1, random_state=None, knn_classifier='knn',
             knn_metric='minkowski', knne=False, DSEL_perc=0.5, n_jobs=-1):
    """Initialize the A Priori classifier."""

def fit(self, X, y):
    """Train the A Priori classifier.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Training data.
    y : array of shape (n_samples)
        Target values.

    Returns
    -------
    self : object
        Returns the instance itself.
    """

def estimate_competence(self, competence_region, distances, predictions=None):
    """Estimate competence using prior knowledge.

    Parameters
    ----------
    competence_region : array of shape (n_samples, n_neighbors)
        Indices of samples in the competence region.
    distances : array of shape (n_samples, n_neighbors)
        Distances to the neighbors.
    predictions : array of shape (n_samples, n_classifiers)
        Predictions from base classifiers.

    Returns
    -------
    competences : array of shape (n_samples, n_classifiers)
        Competence estimates for each classifier.
    """
```

#### 20. BaseDCS Class - Base Dynamic Classifier Selection

**Import Statement**:
```python
from deslib.dcs.base import BaseDCS
```

**Function**: Base class for Dynamic Classifier Selection (DCS) methods. Inherits from BaseDS and provides common DCS functionality.

**Class Definition**:
```python
class BaseDCS(BaseDS):
    """Base class for a Dynamic Classifier Selection (dcs) method.
    All dynamic classifier selection classes should inherit from this class.

    Warning: This class should not be used directly, use derived classes
    instead.

    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=7, DFP=False, safe_k=None,
             with_IH=False, IH_rate=0.30, selection_method='best',
             diff_thresh=0.1, random_state=None, knn_classifier='knn',
             knn_metric='minkowski', DSEL_perc=0.5, knne=False, n_jobs=-1):
    """Initialize the BaseDCS classifier."""


def estimate_competence(self, competence_region, distances=None,
                            predictions=None):
    """Estimate competence of base classifiers.

    Parameters
    ----------
    competence_region : array of shape (n_samples, n_neighbors)
        Indices of samples in the competence region.
    distances : array of shape (n_samples, n_neighbors)
        Distances to the neighbors.
    predictions : array of shape (n_samples, n_classifiers)
        Predictions from base classifiers.

    Returns
    -------
    competences : array of shape (n_samples, n_classifiers)
        Competence estimates for each classifier.
    """

def select(self, competences):
    """Select the best classifier based on competences.

    Parameters
    ----------
    competences : array of shape (n_samples, n_classifiers)
        Competence estimates for each classifier.

    Returns
    -------
    selected_classifiers : array of shape (n_samples, n_classifiers)
        Boolean mask of selected classifiers.
    """

def classify_with_ds(self, predictions, probabilities=None,
                         neighbors=None, distances=None, DFP_mask=None):
    """Classify using dynamic selection.

    Parameters
    ----------
    predictions : array of shape (n_samples, n_classifiers)
        Predictions from base classifiers.
    probabilities : array of shape (n_samples, n_classifiers, n_classes)
        Probabilities from base classifiers.
    neighbors : array of shape (n_samples, n_neighbors)
        Indices of nearest neighbors.
    distances : array of shape (n_samples, n_neighbors)
        Distances to nearest neighbors.
    DFP_mask : array of shape (n_samples, n_classifiers)
        Dynamic frienemy pruning mask.

    Returns
    -------
    predicted_labels : array of shape (n_samples)
        Predicted class labels.
    """

def predict_proba_with_ds(self, predictions, probabilities, neighbors=None, distances=None, DFP_mask=None):
    """Predict probabilities using dynamic selection.

    Parameters
    ----------
    predictions : array of shape (n_samples, n_classifiers)
        Predictions from base classifiers.
    probabilities : array of shape (n_samples, n_classifiers, n_classes)
        Probabilities from base classifiers.
    neighbors : array of shape (n_samples, n_neighbors)
        Indices of nearest neighbors.
    distances : array of shape (n_samples, n_neighbors)
        Distances to nearest neighbors.
    DFP_mask : array of shape (n_samples, n_classifiers)
        Dynamic frienemy pruning mask.

    Returns
    -------
    predicted_probabilities : array of shape (n_samples, n_classes)
        Predicted class probabilities.
    """

def _validate_parameters(self):
    """Validate the input parameters for BaseDCS.
    
    Calls the parent class validation method.
    """
```

**Parameter Description**:
- `pool_classifiers` (list): List of base classifiers, default is None
- `k` (int): Number of neighbors, default is 7
- `DFP` (bool): Whether to use Dynamic Frienemy Pruning, default is False
- `safe_k` (int): Safe k value for IH, default is None
- `with_IH` (bool): Whether to use Instance Hardness, default is False
- `IH_rate` (float): Instance Hardness rate, default is 0.30
- `selection_method` (str): Selection method ('best', 'diff', 'all'), default is 'best'
- `diff_thresh` (float): Difference threshold for selection, default is 0.1
- `random_state` (int): Random state for reproducibility, default is None
- `knn_classifier` (str): KNN classifier type, default is 'knn'
- `knn_metric` (str): Distance metric for KNN, default is 'minkowski'
- `DSEL_perc` (float): Percentage of data for DSEL, default is 0.5
- `knne` (bool): Whether to use KNNE, default is False
- `n_jobs` (int): Number of parallel jobs, default is -1

#### 21. LCA Class - Local Class Accuracy

**Import Statement**:
```python
from deslib.dcs.lca import LCA
```

**Function**: Local Class Accuracy (LCA) dynamic classifier selection method that selects classifiers based on their accuracy for the predicted class in the local region.

**Class Definition**:
```python
class LCA(BaseDCS):
    """Local Class Accuracy (LCA).

    Evaluates the competence level of each individual classifiers and
    select the most competent one to predict the label of each test sample.
    The competence of each base classifier is calculated based on its local
    accuracy with respect to some output class. Consider a classifier
    :math:`c_{i}` that assigns a test sample to class :math:`w_{l}`. The
    competence level of :math:`c_{i}` is estimated by the percentage of the
    local training samples assigned to class :math:`w_{l}` that it predicts
    the correct class label.

    The LCA method selects the base classifier presenting the highest
    competence level. In a case where more than one base classifier achieves
    the same competence level, the one that was evaluated first is selected.
    The selection methodology can be modified by changing the hyper-parameter
    selection_method.


    Parameters
    ----------
    pool_classifiers : list of classifiers (Default = None)
        The generated_pool of classifiers trained for the corresponding
        classification problem. Each base classifiers should support the method
        "predict". If None, then the pool of classifiers is a bagging
        classifier.

    k : int (Default = 7)
        Number of neighbors used to estimate the competence of the base
        classifiers.

    DFP : Boolean (Default = False)
        Determines if the dynamic frienemy pruning is applied.

    with_IH : Boolean (Default = False)
        Whether the hardness level of the region of competence is used to
        decide between using the DS algorithm or the KNN for classification of
        a given query sample.

    safe_k : int (default = None)
        The size of the indecision region.

    IH_rate : float (default = 0.3)
        Hardness threshold. If the hardness level of the competence region is
        lower than the IH_rate the KNN classifier is used. Otherwise, the DS
        algorithm is used for classification.

    selection_method : String (Default = "best")
        Determines which method is used to select the base classifier after
        the competences are estimated.

    diff_thresh : float (Default = 0.1)
        Threshold to measure the difference between the competence level of the
        base classifiers for the random and diff selection schemes. If the
        difference is lower than the threshold, their performance are
        considered equivalent.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    knn_classifier : {'knn', 'faiss', None} (Default = 'knn')
         The algorithm used to estimate the region of competence:

         - 'knn' : will use :class:`KNeighborsClassifier` from sklearn
          :class:`KNNE`.

         - 'faiss' : will use Facebook's Faiss similarity search through the
           class :class:`FaissKNNClassifier`

         - `None` : will use sklearn :class:`KNeighborsClassifier`.

    knn_metric : {'minkowski', 'cosine', 'mahalanobis'} (Default = 'minkowski')
        The metric used by the k-NN classifier to estimate distances.

        - 'minkowski' will use minkowski distance.

        - 'cosine' will use the cosine distance.

        - 'mahalanobis' will use the mahalonibis distance.

    DSEL_perc : float (Default = 0.5)
        Percentage of the input data used to fit DSEL.
        Note: This parameter is only used if the pool of classifier is None or
        unfitted.

    n_jobs : int, default=-1
        The number of parallel jobs to run. None means 1 unless in
        a joblib.parallel_backend context. -1 means using all processors.
        Doesn’t affect fit method.

    References
    ----------
    Woods, Kevin, W. Philip Kegelmeyer, and Kevin Bowyer. "Combination of
    multiple classifiers using local accuracy estimates." IEEE transactions on
    pattern analysis and machine intelligence 19.4 (1997): 405-410.

    Britto, Alceu S., Robert Sabourin, and Luiz ES Oliveira. "Dynamic selection
    of classifiers—a comprehensive review."
    Pattern Recognition 47.11 (2014): 3665-3680.

    R. M. O. Cruz, R. Sabourin, and G. D. Cavalcanti, “Dynamic classifier
    selection: Recent advances and perspectives,”
    Information Fusion, vol. 41, pp. 195 – 216, 2018.

    """

```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=7, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, selection_method='best',
             diff_thresh=0.1, random_state=None, knn_classifier='knn',
             knn_metric='minkowski', DSEL_perc=0.5, knne=False, n_jobs=-1):
    """Initialize the LCA classifier."""

def estimate_competence(self, competence_region, distances=None,
                            predictions=None):
    """estimate the competence of each base classifier :math:`c_{i}` for
        the classification of the query sample using the local class accuracy
        method.

        In this algorithm the k-Nearest Neighbors of the test sample are
        estimated. Then, the local accuracy of the base classifiers is
        estimated by its classification accuracy taking into account only the
        samples from the class :math:`w_{l}` in this neighborhood. In this
        case, :math:`w_{l}` is the class predicted by the base classifier
        :math:`c_{i}`, for the query sample.  The competence level estimate is
        represented by the following equation:

        .. math:: \\delta_{i,j} = \\frac{\\sum_{\\mathbf{x}_{k} \\in
          \\omega_{l}}P(\\omega_{l} \\mid \\mathbf{x}_{k},
          c_{i} )}{\\sum_{k = 1}^{K}P(\\omega_{l} \\mid
          \\mathbf{x}_{k}, c_{i} )}

        where :math:`\\delta_{i,j}` represents the competence level of
        :math:`c_{i}` for the classification of query.

        Parameters
        ----------
        competence_region : array of shape (n_samples, n_neighbors)
            Indices of the k nearest neighbors.

        distances : array of shape (n_samples, n_neighbors)
            Distances from the k nearest neighbors to the query.

        predictions : array of shape (n_samples, n_classifiers)
            Predictions of the base classifiers for the test examples.

        Returns
        -------
        competences : array of shape (n_samples, n_classifiers)
            Competence level estimated for each base classifier and test
            example.
        """
```

#### 22. MCB Class - Multiple Classifier Behaviour

**Import Statement**:
```python
from deslib.dcs.mcb import MCB
```

**Function**: Multiple Classifier Behaviour (MCB) dynamic classifier selection method that considers the behavior of multiple classifiers in the competence region.

**Class Definition**:
```python
class MCB(BaseDCS):
    """Multiple Classifier Behaviour (MCB).

    The MCB method evaluates the competence level of each individual
    classifiers taking into account the local accuracy of the base classifier
    in the region of competence. The region of competence is defined using the
    k-NN and behavioral knowledge space (BKS) method. First the k-nearest
    neighbors of the test sample are computed. Then, the set containing the
    k-nearest neighbors is filtered based on the similarity of the query sample
    and its neighbors using the decision space (BKS representation).

    A single classifier :math:`c_{i}` is selected only if its competence level
    is significantly higher than that of the other base classifiers in the pool
    (higher than a pre-defined threshold). Otherwise, all classifiers in the
    pool are combined using the majority voting rule. The selection methodology
    can be modified by changing the hyper-parameter selection_method.

    Parameters
    ----------
    pool_classifiers : list of classifiers (Default = None)
        The generated_pool of classifiers trained for the corresponding
        classification problem. Each base classifiers should support the method
        "predict". If None, then the pool of classifiers is a bagging
        classifier.

    k : int (Default = 7)
        Number of neighbors used to estimate the competence of the base
        classifiers.

    DFP : Boolean (Default = False)
        Determines if the dynamic frienemy pruning is applied.

    with_IH : Boolean (Default = False)
        Whether the hardness level of the region of competence is used to
        decide between using the DS algorithm or the KNN for classification of
        a given query sample.

    safe_k : int (default = None)
        The size of the indecision region.

    IH_rate : float (default = 0.3)
        Hardness threshold. If the hardness level of the competence region is
        lower than the IH_rate the KNN classifier is used. Otherwise, the DS
        algorithm is used for classification.

    selection_method : String (Default = "best")
        Determines which method is used to select the base classifier after
        the competences are estimated.

    diff_thresh : float (Default = 0.1)
        Threshold to measure the difference between the competence level of the
        base classifiers for the random and diff selection schemes. If the
        difference is lower than the threshold, their performance are
        considered equivalent.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    knn_classifier : {'knn', 'faiss', None} (Default = 'knn')
         The algorithm used to estimate the region of competence:

         - 'knn' will use :class:`KNeighborsClassifier` from sklearn
          :class:`KNNE` available on `deslib.utils.knne`

         - 'faiss' will use Facebook's Faiss similarity search through the
           class :class:`FaissKNNClassifier`

         - None, will use sklearn :class:`KNeighborsClassifier`.

    knn_metric : {'minkowski', 'cosine', 'mahalanobis'} (Default = 'minkowski')
        The metric used by the k-NN classifier to estimate distances.

        - 'minkowski' will use minkowski distance.

        - 'cosine' will use the cosine distance.

        - 'mahalanobis' will use the mahalonibis distance.

    knne : bool (Default=False)
        Whether to use K-Nearest Neighbor Equality (KNNE) for the region
        of competence estimation.

    DSEL_perc : float (Default = 0.5)
        Percentage of the input data used to fit DSEL.
        Note: This parameter is only used if the pool of classifier is None or
        unfitted.

    n_jobs : int, default=-1
        The number of parallel jobs to run. None means 1 unless in
        a joblib.parallel_backend context. -1 means using all processors.
        Doesn’t affect fit method.

    References
    ----------
    Giacinto, Giorgio, and Fabio Roli. "Dynamic classifier selection based on
    multiple classifier behaviour."
    Pattern Recognition 34.9 (2001): 1879-1881.

    Britto, Alceu S., Robert Sabourin, and Luiz ES Oliveira. "Dynamic selection
    of classifiers—a comprehensive review."
    Pattern Recognition 47.11 (2014): 3665-3680.

    Huang, Yea S., and Ching Y. Suen. "A method of combining multiple experts
    for the recognition of unconstrained handwritten numerals." IEEE
    Transactions on Pattern Analysis and Machine Intelligence
    17.1 (1995): 90-94.

    Huang, Yea S., and Ching Y. Suen. "The behavior-knowledge space method for
    combination of multiple classifiers." IEEE Computer Society Conference on
    Computer Vision and Pattern Recognition, 1993.

    R. M. O. Cruz, R. Sabourin, and G. D. Cavalcanti, “Dynamic classifier
    selection: Recent advances and perspectives,”
    Information Fusion, vol. 41, pp. 195 – 216, 2018.
    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=7, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, similarity_threshold=0.7,
             selection_method='diff', diff_thresh=0.1, random_state=None,
             knn_classifier='knn', knn_metric='minkowski', knne=False,
             DSEL_perc=0.5, n_jobs=-1):
    """Initialize the MCB classifier."""

def estimate_competence(self, competence_region, distances=None,
                            predictions=None):
    """estimate the competence of each base classifier :math:`c_{i}` for
        the classification of the query sample using the Multiple Classifier
        Behaviour criterion.

        The region of competence in this method is estimated taking into
        account the feature space and the decision space (using the behaviour
        knowledge space method [4]). First, the k-Nearest Neighbors of the
        query sample are defined in the feature space to compose the region of
        competence. Then, the similarity in the BKS space between the query and
        the instances in the region of competence are estimated using the
        following equations:

        .. math:: S(\\tilde{\\mathbf{x}}_{j},\\tilde{\\mathbf{x}}_{k}) =
            \\frac{1}{M}
            \\sum\\limits_{i = 1}^{M}T(\\mathbf{x}_{j},\\mathbf{x}_{k})

        .. math:: T(\\mathbf{x}_{j},\\mathbf{x}_{k}) =
            \\left\\{\\begin{matrix} 1 & \\text{if} &
            c_{i}(\\mathbf{x}_{j}) =  c_{i}(\\mathbf{x}_{k}),\\\\
            0 & \\text{if} & c_{i}(\\mathbf{x}_{j}) \\neq
            c_{i}(\\mathbf{x}_{k}). \\end{matrix}\\right.

        Where :math:`S(\\tilde{\\mathbf{x}}_{j},\\tilde{\\mathbf{x}}_{k})`
        denotes the similarity between two samples based on the behaviour
        knowledge space method (BKS). Instances with similarity lower than a
        predefined threshold are removed from the region of competence. The
        competence level of the base classifiers are estimated as their
        classification accuracy in the final region of competence.

        Parameters
        ----------
        competence_region : array of shape (n_samples, n_neighbors)
            Indices of the k nearest neighbors.

        distances : array of shape (n_samples, n_neighbors)
            Distances from the k nearest neighbors to the query.

        predictions : array of shape (n_samples, n_classifiers)
            Predictions of the base classifiers for the test examples.

        Returns
        -------
        competences : array of shape (n_samples, n_classifiers)
            Competence level estimated for each base classifier and test
            example.
        """


def _validate_parameters(self):
    """Validate MCB-specific parameters.

    Raises
    ------
    ValueError
        If similarity_threshold is not in valid range.
    """
```

**Parameter Description**:
- `pool_classifiers` (list): List of base classifiers, default is None
- `k` (int): Number of neighbors, default is 7
- `DFP` (bool): Whether to use Dynamic Frienemy Pruning, default is False
- `with_IH` (bool): Whether to use Instance Hardness, default is False
- `safe_k` (int): Safe k value for IH, default is None
- `IH_rate` (float): Instance Hardness rate, default is 0.30
- `similarity_threshold` (float): Threshold for similarity comparison, default is 0.5
- `selection_method` (str): Selection method, default is 'best'
- `diff_thresh` (float): Difference threshold, default is 0.1
- `random_state` (int): Random state, default is None
- `knn_classifier` (str): KNN classifier type, default is 'knn'
- `knn_metric` (str): Distance metric, default is 'minkowski'
- `knne` (bool): Whether to use KNNE, default is False
- `DSEL_perc` (float): Percentage of data for DSEL, default is 0.5
- `n_jobs` (int): Number of parallel jobs, default is -1

#### 23. MLA Class - Modified Local Accuracy

**Import Statement**:
```python
from deslib.dcs.mla import MLA
```

**Function**: Modified Local Accuracy (MLA) dynamic classifier selection method that uses a modified version of local accuracy calculation.

**Class Definition**:
```python
class MLA(BaseDCS):
    """Modified Local Accuracy (MLA).

    Similar to the LCA technique. The only difference is that the output of
    each base classifier is weighted by the distance between the test sample
    and each pattern in the region of competence for the estimation of the
    classifiers competences. Only the classifier that achieved the highest
    competence level is select to predict the label of the test sample x.

    The MLA method selects the base classifier presenting the highest
    competence level. In a case where more than one base classifier achieves
    the same competence level, the one that was evaluated first is selected.
    The selection methodology can be modified by changing the hyper-parameter
    selection_method.

    Parameters
    ----------
    pool_classifiers : list of classifiers (Default = None)
        The generated_pool of classifiers trained for the corresponding
        classification problem. Each base classifiers should support the method
        "predict". If None, then the pool of classifiers is a bagging
        classifier.

    k : int (Default = 7)
        Number of neighbors used to estimate the competence of the base
        classifiers.

    DFP : Boolean (Default = False)
        Determines if the dynamic frienemy pruning is applied.

    with_IH : Boolean (Default = False)
        Whether the hardness level of the region of competence is used to
        decide between using the DS algorithm or the KNN for classification of
        a given query sample.

    safe_k : int (default = None)
        The size of the indecision region.

    IH_rate : float (default = 0.3)
        Hardness threshold. If the hardness level of the competence region is
        lower than the IH_rate the KNN classifier is used. Otherwise, the DS
        algorithm is used for classification.

    selection_method : String (Default = "best")
        Determines which method is used to select the base classifier after
        the competences are estimated.

    diff_thresh : float (Default = 0.1)
        Threshold to measure the difference between the competence level of the
        base classifiers for the random and diff selection schemes. If the
        difference is lower than the threshold, their performance are
        considered equivalent.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    knn_classifier : {'knn', 'faiss', None} (Default = 'knn')
         The algorithm used to estimate the region of competence:

         - 'knn' will use :class:`KNeighborsClassifier` from sklearn
          :class:`KNNE` available on `deslib.utils.knne`

         - 'faiss' will use Facebook's Faiss similarity search through the
           class :class:`FaissKNNClassifier`

         - None, will use sklearn :class:`KNeighborsClassifier`.

    knn_metric : {'minkowski', 'cosine', 'mahalanobis'} (Default = 'minkowski')
        The metric used by the k-NN classifier to estimate distances.

        - 'minkowski' will use minkowski distance.

        - 'cosine' will use the cosine distance.

        - 'mahalanobis' will use the mahalonibis distance.

    knne : bool (Default=False)
        Whether to use K-Nearest Neighbor Equality (KNNE) for the region
        of competence estimation.

    DSEL_perc : float (Default = 0.5)
        Percentage of the input data used to fit DSEL.
        Note: This parameter is only used if the pool of classifier is None or
        unfitted.

    n_jobs : int, default=-1
        The number of parallel jobs to run. None means 1 unless in
        a joblib.parallel_backend context. -1 means using all processors.
        Doesn’t affect fit method.

    References
    ----------
    Woods, Kevin, W. Philip Kegelmeyer, and Kevin Bowyer. "Combination of
    multiple classifiers using local accuracy estimates." IEEE transactions on
    pattern analysis and machine intelligence 19.4 (1997): 405-410.

    Britto, Alceu S., Robert Sabourin, and Luiz ES Oliveira. "Dynamic selection
    of classifiers—a comprehensive review."
    Pattern Recognition 47.11 (2014): 3665-3680.

    R. M. O. Cruz, R. Sabourin, and G. D. Cavalcanti, “Dynamic classifier
    selection: Recent advances and perspectives,”
    Information Fusion, vol. 41, pp. 195 – 216, 2018.

    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=7, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, selection_method='best',
             diff_thresh=0.1, random_state=None, knn_classifier='knn',
             knn_metric='minkowski', knne=False, DSEL_perc=0.5, n_jobs=-1):
    """Initialize the MLA classifier."""

def estimate_competence(self, competence_region, distances, predictions=None):
    """Estimate competence using modified local accuracy.

    Parameters
    ----------
    competence_region : array of shape (n_samples, n_neighbors)
        Indices of samples in the competence region.
    distances : array of shape (n_samples, n_neighbors)
        Distances to the neighbors.
    predictions : array of shape (n_samples, n_classifiers)
        Predictions from base classifiers.

    Returns
    -------
    competences : array of shape (n_samples, n_classifiers)
        Modified local accuracy for each classifier.
    """
```

#### 24. Rank Class - Ranking-based Selection

**Import Statement**:
```python
from deslib.dcs.rank import Rank
```

**Function**: Ranking-based dynamic classifier selection method that ranks classifiers based on their performance.

**Class Definition**:
```python
class Rank(BaseDCS):
    """Modified Classifier Rank.

    The modified classifier rank method evaluates the competence level of each
    individual classifiers and select the most competent one to predict the
    label of each test sample :math:`x`. The competence of each base classifier
    is calculated as the number of correctly classified samples, starting from
    the closest neighbor of :math:`x`. The classifier with the highest number
    of correctly classified samples is considered the most competent.

    The Rank method selects the base classifier presenting the highest
    competence level. In a case where more than one base classifier achieves
    the same competence level, the one that was evaluated first is selected.
    The selection methodology can be modified by changing the hyper-parameter
    selection_method.

    Parameters
    ----------
    pool_classifiers : list of classifiers (Default = None)
        The generated_pool of classifiers trained for the corresponding
        classification problem. Each base classifiers should support the method
        "predict". If None, then the pool of classifiers is a bagging
        classifier.

    k : int (Default = 7)
        Number of neighbors used to estimate the competence of the base
        classifiers.

    DFP : Boolean (Default = False)
        Determines if the dynamic frienemy pruning is applied.

    with_IH : Boolean (Default = False)
        Whether the hardness level of the region of competence is used to
        decide between using the DS algorithm or the KNN for classification of
        a given query sample.

    safe_k : int (default = None)
        The size of the indecision region.

    IH_rate : float (default = 0.3)
        Hardness threshold. If the hardness level of the competence region is
        lower than the IH_rate the KNN classifier is used. Otherwise, the DS
        algorithm is used for classification.

    selection_method : String (Default = "best")
        Determines which method is used to select the base classifier after
        the competences are estimated.

    diff_thresh : float (Default = 0.1)
        Threshold to measure the difference between the competence level of the
        base classifiers for the random and diff selection schemes. If the
        difference is lower than the threshold, their performance are
        considered equivalent.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    knn_classifier : {'knn', 'faiss', None} (Default = 'knn')
         The algorithm used to estimate the region of competence:

         - 'knn' will use :class:`KNeighborsClassifier` from sklearn
          :class:`KNNE` available on `deslib.utils.knne`

         - 'faiss' will use Facebook's Faiss similarity search through the
           class :class:`FaissKNNClassifier`

         - None, will use sklearn :class:`KNeighborsClassifier`.

    knn_metric : {'minkowski', 'cosine', 'mahalanobis'} (Default = 'minkowski')
        The metric used by the k-NN classifier to estimate distances.

        - 'minkowski' will use minkowski distance.

        - 'cosine' will use the cosine distance.

        - 'mahalanobis' will use the mahalonibis distance.

    knne : bool (Default=False)
        Whether to use K-Nearest Neighbor Equality (KNNE) for the region
        of competence estimation.

    DSEL_perc : float (Default = 0.5)
        Percentage of the input data used to fit DSEL.
        Note: This parameter is only used if the pool of classifier is None or
        unfitted.

    n_jobs : int, default=-1
        The number of parallel jobs to run. None means 1 unless in
        a joblib.parallel_backend context. -1 means using all processors.
        Doesn’t affect fit method.

    References
    ----------
    Woods, Kevin, W. Philip Kegelmeyer, and Kevin Bowyer. "Combination of
    multiple classifiers using local accuracy estimates." IEEE transactions on
    pattern analysis and machine intelligence 19.4 (1997): 405-410.

    M. Sabourin, A. Mitiche, D. Thomas, G. Nagy, Classifier combination for
    handprinted digit recognition, International Conference on Document
    Analysis and Recognition (1993) 163–166.

    Britto, Alceu S., Robert Sabourin, and Luiz ES Oliveira. "Dynamic selection
    of classifiers—a comprehensive review."
    Pattern Recognition 47.11 (2014): 3665-3680.

    R. M. O. Cruz, R. Sabourin, and G. D. Cavalcanti, “Dynamic classifier
    selection: Recent advances and perspectives,”
    Information Fusion, vol. 41, pp. 195 – 216, 2018.

    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=7, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, selection_method='best',
             diff_thresh=0.1, random_state=None, knn_classifier='knn',
             knn_metric='minkowski', knne=False, DSEL_perc=0.5, n_jobs=-1):
    """Initialize the Rank classifier."""

def estimate_competence(self, competence_region, distances=None,
                            predictions=None):
    """estimate the competence level of each base classifier :math:`c_{i}`
        for the classification of the query sample using the modified ranking
        scheme. The rank of the base classifier is estimated by the number of
        consecutive correctly classified samples in the defined region of
        competence.

        Parameters
        ----------
        competence_region : array of shape (n_samples, n_neighbors)
            Indices of the k nearest neighbors.

        distances : array of shape (n_samples, n_neighbors)
            Distances from the k nearest neighbors to the query.

        predictions : array of shape (n_samples, n_classifiers)
            Predictions of the base classifiers for the test examples.

        Returns
        -------
        competences : array of shape (n_samples, n_classifiers)
            Competence level estimated for each base classifier and test
            example.
        """
```

#### 25. Module Exports and Version Information

**Function**: Module-level exports and version information for the DESlib package.

##### Main Package Exports (`deslib/__init__.py`)
```python
__all__ = ['des', 'dcs', 'static', 'util', 'tests']
__version__ = '0.3.7'
```

##### Static Module Exports (`deslib/static/__init__.py`)
```python
__all__ = ['Oracle', 'SingleBest', 'StaticSelection', 'StackedClassifier']
```

##### DCS Module Exports (`deslib/dcs/__init__.py`)
```python
__all__ = ['BaseDCS',
           'APosteriori',
           'APriori',
           'LCA',
           'OLA',
           'MLA',
           'MCB',
           'Rank']
```

##### DES Module Exports (`deslib/des/__init__.py`)
```python
__all__ = ['BaseDES',
           'METADES',
           'KNORAE',
           'KNORAU',
           'KNOP',
           'DESP',
           'DESKNN',
           'DESClustering',
           'DESMI',
           'BaseProbabilistic',
           'RRC',
           'DESKL',
           'MinimumDifference',
           'Exponential',
           'Logarithmic']
```

#### 26. Example Constants and Variables

**Function**: Important constants and variables used throughout the examples and benchmarks.

##### Example Variables
- `X_DSEL`: Dynamic selection dataset features (used in examples)
- `X`: General feature matrix variable (used across examples)
- `RF`: Random Forest classifier instance (used in random forest example)
- `X_train`: Training feature matrix (preprocessed with scaler)
- `X_test`: Test feature matrix (preprocessed with scaler)

These variables are commonly used in the example scripts to demonstrate:
- Data preprocessing and scaling
- Dynamic selection dataset preparation
- Classifier pool creation and training
- Performance evaluation and comparison

#### 27. Benchmarking Functions

**Import Statement**:
```python
# Located in: benchmarks/
from benchmarks.bench_speed_faiss import run_knorae, fetch_HIGGS
from benchmarks.bench_ds_performance_faiss import sk_KNORAE_knn, faiss_KNORAE_knn
```

**Function**: Functions for performance benchmarking and dataset fetching.

##### run_knorae(pool_classifiers, X_DSEL, y_DSEL, X_test, y_test, knn_type)
```python
def run_knorae(pool_classifiers, X_DSEL, y_DSEL, X_test, y_test, knn_type):
    """Run KNORAE benchmark with specified KNN type.
    
    Parameters
    ----------
    pool_classifiers : list
        List of base classifiers.
    X_DSEL, y_DSEL : arrays
        Dynamic selection dataset.
    X_test, y_test : arrays
        Test dataset.
    knn_type : str
        KNN implementation type ('knn' or 'faiss').
        
    Returns
    -------
    score : float
        Classification accuracy.
    time : float
        Execution time.
    """
```

##### fetch_HIGGS()
```python
def fetch_HIGGS():
    """Fetch the HIGGS dataset for benchmarking.
    
    Downloads and extracts the HIGGS dataset from UCI repository
    if not already available locally.
    
    Returns
    -------
    X : array
        Feature matrix.
    y : array
        Target labels.
    """
```

##### sk_KNORAE_knn(XTrain, YTrain, k, XTest, YTest)
```python
def sk_KNORAE_knn(XTrain, YTrain, k, XTest, YTest):
    """Benchmark KNORAE with scikit-learn KNN.
    
    Parameters
    ----------
    XTrain, YTrain : arrays
        Training data.
    k : int
        Number of neighbors.
    XTest, YTest : arrays
        Test data.
        
    Returns
    -------
    accuracy : float
        Classification accuracy.
    time : float
        Execution time.
    """
```

##### faiss_KNORAE_knn(XTrain, YTrain, k, XTest, YTest)
```python
def faiss_KNORAE_knn(XTrain, YTrain, k, XTest, YTest):
    """Benchmark KNORAE with FAISS KNN.
    
    Parameters
    ----------
    XTrain, YTrain : arrays
        Training data.
    k : int
        Number of neighbors.
    XTest, YTest : arrays
        Test data.
        
    Returns
    -------
    accuracy : float
        Classification accuracy.
    time : float
        Execution time.
    """
```





#### 28. BaseProbabilistic Class - Base Probabilistic Dynamic Selection

**Import Statement**:
```python
from deslib.des.probabilistic.base import BaseProbabilistic
```

**Function**: Base class for probabilistic dynamic ensemble selection methods that use probability-based competence measures.

**Class Definition**:
```python
class BaseProbabilistic(BaseDES):
    """Base class for a DS method based on the potential function model.
    All DS methods based on the Potential function should inherit from this
    class.

    Warning: This class should not be used directly.
    Use derived classes instead.

    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=None, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, mode='selection', voting='hard',
             selection_threshold=None, random_state=None,
             knn_classifier='knn', knn_metric='minkowski',
             DSEL_perc=0.5, n_jobs=-1):
    """Initialize the BaseProbabilistic classifier.
    
    Parameters
    ----------
    pool_classifiers : list, default=None
        List of base classifiers.
    k : int, default=None
        Number of neighbors.
    DFP : bool, default=False
        Whether to use Dynamic Frienemy Pruning.
    with_IH : bool, default=False
        Whether to use Instance Hardness.
    safe_k : int, default=None
        Safe k value for IH.
    IH_rate : float, default=0.30
        Instance Hardness rate.
    mode : str, default='selection'
        Selection mode ('selection', 'weighting', 'hybrid').
    voting : str, default='hard'
        Voting method ('hard', 'soft').
    selection_threshold : float, default=None
        Threshold for classifier selection.
    random_state : int, default=None
        Random state for reproducibility.
    knn_classifier : str, default='knn'
        KNN classifier type.
    knn_metric : str, default='minkowski'
        Distance metric for KNN.
    DSEL_perc : float, default=0.5
        Percentage of data for DSEL.
    n_jobs : int, default=-1
        Number of parallel jobs.
    """

def fit(self, X, y):
    """Train the probabilistic dynamic ensemble selection method.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        The input data.
    y : array of shape (n_samples)
        Class labels of each example in X.

    Returns
    -------
    self
    """

def estimate_competence(self, competence_region, distances, predictions=None):
    """Estimate the competence of each base classifier using probabilistic measures.

    Parameters
    ----------
    competence_region : array of shape (n_samples, n_neighbors)
        Indices of the k nearest neighbors.
    distances : array of shape (n_samples, n_neighbors)
        Distances from the k nearest neighbors to the query.
    predictions : array of shape (n_samples, n_classifiers)
        Predictions of the base classifiers for all test examples.

    Returns
    -------
    competences : array of shape (n_samples, n_classifiers)
        Competence level estimated for each base classifier and test example.
    """

def select(self, competences):
    """Select classifiers based on probabilistic criteria.

    Parameters
    ----------
    competences : array of shape (n_samples, n_classifiers)
        Competence level estimated for each base classifier and test example.

    Returns
    -------
    selected_classifiers : array of shape (n_samples, n_classifiers)
        Boolean matrix containing True if the base classifier is selected,
        False otherwise.
    """

@staticmethod
def potential_func(dist):
    """Gaussian potential function to decrease the
    influence of the source of competence as the distance between
    :math:`\\mathbf{x}_{k}` and the query :math:`\\mathbf{x}_{q}`
    increases. The function is computed using the following equation:

    .. math:: potential = exp( -dist (\\mathbf{x}_{k},
     \\mathbf{x}_{q})^{2} )

    where dist represents the Euclidean distance between
    :math:`\\mathbf{x}_{k}` and :math:`\\mathbf{x}_{q}`

    Parameters
    ----------
    dist : array of shape = [self.n_samples]
           distance between the corresponding sample to the query

    Returns
    -------
    The result of the potential function for each value in (dist)
    """

@abstractmethod
def source_competence(self):
    """Method used to estimate the source of competence at each data
    point.

    Each DS technique based on this paradigm should define its
    computation of C_src

    Returns
    -------
    C_src : array of shape (n_samples, n_classifiers)
        The competence source for each base classifier at each data point
        in DSEL.
    """

def _validate_parameters(self):
    """Validate the input parameters for BaseProbabilistic.
    
    Checks if the selection_threshold is valid and calls parent validation.
    """
```

**Parameter Description**:
- `pool_classifiers` (list): List of base classifiers, default is None
- `k` (int): Number of neighbors, default is None
- `DFP` (bool): Whether to use Dynamic Frienemy Pruning, default is False
- `with_IH` (bool): Whether to use Instance Hardness, default is False
- `safe_k` (int): Safe k value for IH, default is None
- `IH_rate` (float): Instance Hardness rate, default is 0.30
- `mode` (str): Selection mode ('selection', 'weighting', 'hybrid'), default is 'selection'
- `voting` (str): Voting method ('hard', 'soft'), default is 'hard'
- `selection_threshold` (float): Threshold for classifier selection, default is None
- `random_state` (int): Random state for reproducibility, default is None
- `knn_classifier` (str): KNN classifier type, default is 'knn'
- `knn_metric` (str): Distance metric for KNN, default is 'minkowski'
- `DSEL_perc` (float): Percentage of data for DSEL, default is 0.5
- `n_jobs` (int): Number of parallel jobs, default is -1

#### 30. RRC Class - Randomized Reference Classifier

**Import Statement**:
```python
from deslib.des.probabilistic.rrc import RRC
```

**Function**: Randomized Reference Classifier probabilistic dynamic ensemble selection method.

**Class Definition**:
```python
class RRC(BaseProbabilistic):
    """DES technique based on the Randomized Reference Classifier method
    (DES-RRC).

    Parameters
    ----------
     pool_classifiers : list of classifiers (Default = None)
        The generated_pool of classifiers trained for the corresponding
        classification problem. Each base classifiers should support the method
        "predict". If None, then the pool of classifiers is a bagging
        classifier.

    k : int (Default = 7)
        Number of neighbors used to estimate the competence of the base
        classifiers.

    DFP : Boolean (Default = False)
        Determines if the dynamic frienemy pruning is applied.

    with_IH : Boolean (Default = False)
        Whether the hardness level of the region of competence is used to
        decide between using the DS algorithm or the KNN for classification of
        a given query sample.

    safe_k : int (default = None)
        The size of the indecision region.

    IH_rate : float (default = 0.3)
        Hardness threshold. If the hardness level of the competence region is
        lower than the IH_rate the KNN classifier is used. Otherwise, the DS
        algorithm is used for classification.

    mode : String (Default = "selection")
           Whether the technique will perform dynamic selection,
           dynamic weighting or an hybrid approach for classification.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    knn_classifier : {'knn', 'faiss', None} (Default = 'knn')
         The algorithm used to estimate the region of competence:

         - 'knn' will use :class:`KNeighborsClassifier` from sklearn

         - 'faiss' will use Facebook's Faiss similarity search through the
           class :class:`FaissKNNClassifier`

         - None, will use sklearn :class:`KNeighborsClassifier`.

    knn_metric : {'minkowski', 'cosine', 'mahalanobis'} (Default = 'minkowski')
        The metric used by the k-NN classifier to estimate distances.

        - 'minkowski' will use minkowski distance.

        - 'cosine' will use the cosine distance.

        - 'mahalanobis' will use the mahalonibis distance.

    DSEL_perc : float (Default = 0.5)
        Percentage of the input data used to fit DSEL.
        Note: This parameter is only used if the pool of classifier is None or
        unfitted.

    voting : {'hard', 'soft'}, default='hard'
            If 'hard', uses predicted class labels for majority rule voting.
            Else if 'soft', predicts the class label based on the argmax of
            the sums of the predicted probabilities, which is recommended for
            an ensemble of well-calibrated classifiers.

    n_jobs : int, default=-1
        The number of parallel jobs to run. None means 1 unless in
        a joblib.parallel_backend context. -1 means using all processors.
        Doesn’t affect fit method.

    References
    ----------
    Woloszynski, Tomasz, and Marek Kurzynski. "A probabilistic model of
    classifier competence for dynamic ensemble selection." Pattern Recognition
    44.10 (2011): 2656-2668.

    R. M. O. Cruz, R. Sabourin, and G. D. Cavalcanti, “Dynamic classifier
    selection: Recent advances and perspectives,”
    Information Fusion, vol. 41, pp. 195 – 216, 2018.

    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=None, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, mode='selection', random_state=None,
             knn_classifier='knn', knn_metric='minkowski',
             DSEL_perc=0.5, n_jobs=-1, voting='hard'):
    """Initialize the RRC classifier."""

def source_competence(self):
    """
    Calculates the source of competence using the randomized reference
    classifier (RRC) method.

    The source of competence C_src at the validation point
    :math:`\\mathbf{x}_{k}` calculated using the probabilistic model
    based on the supports obtained by the base classifier and
    randomized reference classifier (RRC) model. The probabilistic
    modeling of the classifier competence is calculated using
    the ccprmod function.

    Returns
    ----------
    C_src : array of shape (n_samples, n_classifiers)
    The competence source for each base classifier at each data point.
    """
```

#### 31. DESKL Class - Dynamic Ensemble Selection Kullback-Leibler

**Import Statement**:
```python
from deslib.des.probabilistic.deskl import DESKL
```

**Function**: Dynamic Ensemble Selection using Kullback-Leibler divergence for probabilistic competence estimation.

**Class Definition**:
```python
class DESKL(BaseProbabilistic):
    """Dynamic Ensemble Selection-Kullback-Leibler divergence (DES-KL).

    This method estimates the competence of the classifier from the information
    theory perspective. The competence of the base classifiers is calculated as
    the KL divergence between the vector of class supports produced by the base
    classifier and the outputs of a random classifier (RC)
    RC = 1/L, L being the number of classes in the problem. Classifiers with a
    competence higher than the competence of the random classifier is selected.

    Parameters
    ----------
     pool_classifiers : list of classifiers (Default = None)
        The generated_pool of classifiers trained for the corresponding
        classification problem. Each base classifiers should support the method
        "predict". If None, then the pool of classifiers is a bagging
        classifier.

    k : int (Default = 7)
        Number of neighbors used to estimate the competence of the base
        classifiers.

    DFP : Boolean (Default = False)
        Determines if the dynamic frienemy pruning is applied.

    with_IH : Boolean (Default = False)
        Whether the hardness level of the region of competence is used to
        decide between using the DS algorithm or the KNN for classification of
        a given query sample.

    safe_k : int (default = None)
        The size of the indecision region.

    IH_rate : float (default = 0.3)
        Hardness threshold. If the hardness level of the competence region is
        lower than the IH_rate the KNN classifier is used. Otherwise, the DS
        algorithm is used for classification.

    mode : String (Default = "selection")
           Whether the technique will perform dynamic selection,
           dynamic weighting or an hybrid approach for classification.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    knn_classifier : {'knn', 'faiss', None} (Default = 'knn')
         The algorithm used to estimate the region of competence:

         - 'knn' will use :class:`KNeighborsClassifier` from sklearn

         - 'faiss' will use Facebook's Faiss similarity search through the
           class :class:`FaissKNNClassifier`

         - None, will use sklearn :class:`KNeighborsClassifier`.

    knn_metric : {'minkowski', 'cosine', 'mahalanobis'} (Default = 'minkowski')
        The metric used by the k-NN classifier to estimate distances.

        - 'minkowski' will use minkowski distance.

        - 'cosine' will use the cosine distance.

        - 'mahalanobis' will use the mahalonibis distance.

    DSEL_perc : float (Default = 0.5)
        Percentage of the input data used to fit DSEL.
        Note: This parameter is only used if the pool of classifier is None or
        unfitted.

    voting : {'hard', 'soft'}, default='hard'
            If 'hard', uses predicted class labels for majority rule voting.
            Else if 'soft', predicts the class label based on the argmax of
            the sums of the predicted probabilities, which is recommended for
            an ensemble of well-calibrated classifiers.

    n_jobs : int, default=-1
        The number of parallel jobs to run. None means 1 unless in
        a joblib.parallel_backend context. -1 means using all processors.
        Doesn’t affect fit method.

    References
    ----------
    Woloszynski, Tomasz, et al. "A measure of competence based on random
    classification for dynamic ensemble selection."
    Information Fusion 13.3 (2012): 207-213.

    Woloszynski, Tomasz, and Marek Kurzynski. "A probabilistic model of
    classifier competence for dynamic ensemble selection."
    Pattern Recognition 44.10 (2011): 2656-2668.

    R. M. O. Cruz, R. Sabourin, and G. D. Cavalcanti, “Dynamic classifier
    selection: Recent advances and perspectives,”
    Information Fusion, vol. 41, pp. 195 – 216, 2018.

    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=None, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, mode='selection', random_state=None,
             knn_classifier='knn', knn_metric='minkowski',
             DSEL_perc=0.5, n_jobs=-1, voting='hard'):
    """Initialize the DESKL classifier."""

def source_competence(self):
    """Calculates the source of competence using the KL divergence method.

    The source of competence C_src at the validation point
    :math:`\\mathbf{x}_{k}` is calculated by the KL divergence
    between the vector of class supports produced by the base classifier
    and the outputs of a random classifier (RC) RC = 1/L, L being the
    number of classes in the problem. The value of C_src is negative if
    the base classifier misclassified the instance :math:`\\mathbf{x}_{k}`.

    Returns
    ----------
    C_src : array of shape (n_samples, n_classifiers)
        The competence source for each base classifier at each data point.
    """
```

#### 32. MinimumDifference Class - Minimum Difference Probabilistic Selection

**Import Statement**:
```python
from deslib.des.probabilistic.minimum_difference import MinimumDifference
```

**Function**: Minimum Difference probabilistic dynamic ensemble selection method.

**Class Definition**:
```python
class MinimumDifference(BaseProbabilistic):
   """
    Computes the competence level of the classifiers based on the difference
    between the support obtained by each class. The competence level at a data
    point :math:`\\mathbf{x}_{k}` is equal to the minimum difference between
    the support obtained to the correct class and the support obtained for
    different classes.

    The influence of each sample xk is defined according to a Gaussian function
    model[2]. Samples that are closer to the query have a higher influence
    in the competence estimation.

    Parameters
    ----------
     pool_classifiers : list of classifiers (Default = None)
        The generated_pool of classifiers trained for the corresponding
        classification problem. Each base classifiers should support the method
        "predict". If None, then the pool of classifiers is a bagging
        classifier.

    k : int (Default = 7)
        Number of neighbors used to estimate the competence of the base
        classifiers.

    DFP : Boolean (Default = False)
        Determines if the dynamic frienemy pruning is applied.

    with_IH : Boolean (Default = False)
        Whether the hardness level of the region of competence is used to
        decide between using the DS algorithm or the KNN for classification of
        a given query sample.

    safe_k : int (default = None)
        The size of the indecision region.

    IH_rate : float (default = 0.3)
        Hardness threshold. If the hardness level of the competence region is
        lower than the IH_rate the KNN classifier is used. Otherwise, the DS
        algorithm is used for classification.


    mode : String (Default = "selection")
           Whether the technique will perform dynamic selection,
           dynamic weighting or an hybrid approach for classification.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    knn_classifier : {'knn', 'faiss', None} (Default = 'knn')
         The algorithm used to estimate the region of competence:

         - 'knn' will use :class:`KNeighborsClassifier` from sklearn

         - 'faiss' will use Facebook's Faiss similarity search through the
           class :class:`FaissKNNClassifier`

         - None, will use sklearn :class:`KNeighborsClassifier`.

    knn_metric : {'minkowski', 'cosine', 'mahalanobis'} (Default = 'minkowski')
        The metric used by the k-NN classifier to estimate distances.

        - 'minkowski' will use minkowski distance.

        - 'cosine' will use the cosine distance.

        - 'mahalanobis' will use the mahalonibis distance.

    DSEL_perc : float (Default = 0.5)
        Percentage of the input data used to fit DSEL.
        Note: This parameter is only used if the pool of classifier is None or
        unfitted.

    voting : {'hard', 'soft'}, default='hard'
            If 'hard', uses predicted class labels for majority rule voting.
            Else if 'soft', predicts the class label based on the argmax of
            the sums of the predicted probabilities, which is recommended for
            an ensemble of well-calibrated classifiers.

    n_jobs : int, default=-1
        The number of parallel jobs to run. None means 1 unless in
        a joblib.parallel_backend context. -1 means using all processors.
        Doesn’t affect fit method.

    References
    ----------
    [1] B. Antosik, M. Kurzynski, New measures of classifier competence
    – heuristics and application to the design of
    multiple classifier systems., in: Computer recognition systems
    4., 2011, pp. 197–206.

    [2] Woloszynski, Tomasz, and Marek Kurzynski. "A probabilistic model of
    classifier competence for dynamic ensemble selection."
    Pattern Recognition 44.10 (2011): 2656-2668.

    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=None, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, mode='selection', random_state=None,
             knn_classifier='knn', knn_metric='minkowski',
             DSEL_perc=0.5, n_jobs=-1, voting='hard'):
    """Initialize the MinimumDifference classifier."""

def source_competence(self):
    """Calculate competence using minimum difference.

    Returns
    -------
    competences : array of shape (n_samples, n_classifiers)
        Competence values calculated using minimum difference approach.
    """
```

#### 33. Exponential Class - Exponential Probabilistic Selection

**Import Statement**:
```python
from deslib.des.probabilistic.exponential import Exponential
```

**Function**: Exponential probabilistic dynamic ensemble selection method.

**Class Definition**:
```python
class Exponential(BaseProbabilistic):
    """The source of competence C_src at the validation point
    :math:`\\mathbf{x}_{k}` is a product of two factors: The absolute value of
    the competence and the sign. The value of the source competence is
    inverse proportional to the normalized entropy of its supports vector.
    The sign of competence is simply determined by correct/incorrect
    classification of :math:`\\mathbf{x}_{k}` [1].

    The influence of each sample :math:`\\mathbf{x}_{k}` is defined according
    to a Gaussian function model[2]. Samples that are closer to the query have
    a higher influence in the competence estimation.

    Parameters
    ----------
     pool_classifiers : list of classifiers (Default = None)
        The generated_pool of classifiers trained for the corresponding
        classification problem. Each base classifiers should support the method
        "predict". If None, then the pool of classifiers is a bagging
        classifier.

    k : int (Default = 7)
        Number of neighbors used to estimate the competence of the base
        classifiers.

    DFP : Boolean (Default = False)
        Determines if the dynamic frienemy pruning is applied.

    with_IH : Boolean (Default = False)
        Whether the hardness level of the region of competence is used to
        decide between using the DS algorithm or the KNN for classification of
        a given query sample.

    safe_k : int (default = None)
        The size of the indecision region.

    IH_rate : float (default = 0.3)
        Hardness threshold. If the hardness level of the competence region is
        lower than the IH_rate the KNN classifier is used. Otherwise, the DS
        algorithm is used for classification.


    mode : String (Default = "selection")
           Whether the technique will perform dynamic selection,
           dynamic weighting or an hybrid approach for classification.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    knn_classifier : {'knn', 'faiss', None} (Default = 'knn')
         The algorithm used to estimate the region of competence:

         - 'knn' will use :class:`KNeighborsClassifier` from sklearn

         - 'faiss' will use Facebook's Faiss similarity search through the
           class :class:`FaissKNNClassifier`

         - None, will use sklearn :class:`KNeighborsClassifier`.

    knn_metric : {'minkowski', 'cosine', 'mahalanobis'} (Default = 'minkowski')
        The metric used by the k-NN classifier to estimate distances.

        - 'minkowski' will use minkowski distance.

        - 'cosine' will use the cosine distance.

        - 'mahalanobis' will use the mahalonibis distance.

    DSEL_perc : float (Default = 0.5)
        Percentage of the input data used to fit DSEL.
        Note: This parameter is only used if the pool of classifier is None or
        unfitted.

    voting : {'hard', 'soft'}, default='hard'
            If 'hard', uses predicted class labels for majority rule voting.
            Else if 'soft', predicts the class label based on the argmax of
            the sums of the predicted probabilities, which is recommended for
            an ensemble of well-calibrated classifiers.

    n_jobs : int, default=-1
        The number of parallel jobs to run. None means 1 unless in
        a joblib.parallel_backend context. -1 means using all processors.
        Doesn’t affect fit method.

    References
    ----------
    [1] B. Antosik, M. Kurzynski, New measures of classifier competence
    – heuristics and application to the design of multiple classifier systems.,
    in: Computer recognition systems 4., 2011, pp. 197–206.

    [2] Woloszynski, Tomasz, and Marek Kurzynski. "A probabilistic model of
    classifier competence for dynamic ensemble selection."
    Pattern Recognition 44.10 (2011): 2656-2668.

    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=None, DFP=False, safe_k=None,
             with_IH=False, IH_rate=0.30, mode='selection', random_state=None,
             knn_classifier='knn', knn_metric='minkowski',
             DSEL_perc=0.5, n_jobs=-1, voting='hard'):
    """Initialize the Exponential classifier."""

def source_competence(self):
    """Calculate competence using exponential function.

    Returns
    -------
    competences : array of shape (n_samples, n_classifiers)
        Competence values calculated using exponential function.
    """
```

#### 34. Logarithmic Class - Logarithmic Probabilistic Selection

**Import Statement**:
```python
from deslib.des.probabilistic.logarithmic import Logarithmic
```

**Function**: Logarithmic probabilistic dynamic ensemble selection method.

**Class Definition**:
```python
class Logarithmic(BaseProbabilistic):
     """ This method estimates the competence of the classifier based on
    the logarithmic difference between the supports obtained by the
    base classifier.

    Parameters
    ----------
     pool_classifiers : list of classifiers (Default = None)
        The generated_pool of classifiers trained for the corresponding
        classification problem. Each base classifiers should support the method
        "predict". If None, then the pool of classifiers is a bagging
        classifier.

    k : int (Default = 7)
        Number of neighbors used to estimate the competence of the base
        classifiers.

    DFP : Boolean (Default = False)
        Determines if the dynamic frienemy pruning is applied.

    with_IH : Boolean (Default = False)
        Whether the hardness level of the region of competence is used to
        decide between using the DS algorithm or the KNN for classification of
        a given query sample.

    safe_k : int (default = None)
        The size of the indecision region.

    IH_rate : float (default = 0.3)
        Hardness threshold. If the hardness level of the competence region is
        lower than the IH_rate the KNN classifier is used. Otherwise, the DS
        algorithm is used for classification.

    mode : String (Default = "selection")
           Whether the technique will perform dynamic selection,
           dynamic weighting or an hybrid approach for classification.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    knn_classifier : {'knn', 'faiss', None} (Default = 'knn')
         The algorithm used to estimate the region of competence:

         - 'knn' will use :class:`KNeighborsClassifier` from sklearn

         - 'faiss' will use Facebook's Faiss similarity search through the
           class :class:`FaissKNNClassifier`

         - None, will use sklearn :class:`KNeighborsClassifier`.

    knn_metric : {'minkowski', 'cosine', 'mahalanobis'} (Default = 'minkowski')
        The metric used by the k-NN classifier to estimate distances.

        - 'minkowski' will use minkowski distance.

        - 'cosine' will use the cosine distance.

        - 'mahalanobis' will use the mahalonibis distance.

    DSEL_perc : float (Default = 0.5)
        Percentage of the input data used to fit DSEL.
        Note: This parameter is only used if the pool of classifier is None or
        unfitted.

    voting : {'hard', 'soft'}, default='hard'
            If 'hard', uses predicted class labels for majority rule voting.
            Else if 'soft', predicts the class label based on the argmax of
            the sums of the predicted probabilities, which is recommended for
            an ensemble of well-calibrated classifiers.

    n_jobs : int, default=-1
        The number of parallel jobs to run. None means 1 unless in
        a joblib.parallel_backend context. -1 means using all processors.
        Doesn’t affect fit method.

    References
    ----------
    B. Antosik, M. Kurzynski, New measures of classifier competence
    – heuristics and application to the design of
    multiple classifier systems., in: Computer recognition systems
    4., 2011, pp. 197–206.

    T.Woloszynski, M. Kurzynski, A measure of competence based on randomized
    reference classifier for dynamic ensemble selection, in: International
    Conference on Pattern Recognition (ICPR), 2010, pp. 4194–4197.
    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=None, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, mode='selection', random_state=None,
             knn_classifier='knn', knn_metric='minkowski',
             DSEL_perc=0.5, n_jobs=-1, voting='hard'):
    """Initialize the Logarithmic classifier."""

def source_competence(self):
    """The source of competence C_src at the validation point
        :math:`\\mathbf{x}_{k}` is calculated by
        logarithm function in the support obtained by the base classifier.

        Returns
        ----------
        C_src : array of shape (n_samples, n_classifiers)
            The competence source for each base classifier at each data point.
        """
```

#### 35. BaseDES Class - Base Dynamic Ensemble Selection

**Import Statement**:
```python
from deslib.des.base import BaseDES
```

**Function**: Base class for Dynamic Ensemble Selection (DES) methods. Inherits from BaseDS and provides common DES functionality.

**Class Definition**:
```python
class BaseDES(BaseDS):
    """Base class for a Dynamic Ensemble Selection (DES).

    All dynamic ensemble selection techniques should inherit from this class.

    Warning: This class should not be instantiated directly, use
    derived classes instead.

    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=7, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, mode='selection', voting='hard',
             needs_proba=False, random_state=None, knn_classifier='knn',
             knn_metric='minkowski', knne=False, DSEL_perc=0.5, n_jobs=-1):
    """Initialize the BaseDES classifier.
    
    Parameters
    ----------
    pool_classifiers : list, default=None
        List of base classifiers.
    k : int, default=7
        Number of neighbors.
    DFP : bool, default=False
        Whether to use Dynamic Frienemy Pruning.
    with_IH : bool, default=False
        Whether to use Instance Hardness.
    safe_k : int, default=None
        Safe k value for IH.
    IH_rate : float, default=0.30
        Instance Hardness rate.
    mode : str, default='selection'
        Selection mode ('selection', 'weighting', 'hybrid').
    voting : str, default='hard'
        Voting method ('hard' or 'soft').
    needs_proba : bool, default=False
        Whether the method needs probability estimates.
    random_state : int, default=None
        Random state for reproducibility.
    knn_classifier : str, default='knn'
        KNN classifier type.
    knn_metric : str, default='minkowski'
        Distance metric for KNN.
    knne : bool, default=False
        Whether to use KNNE.
    DSEL_perc : float, default=0.5
        Percentage of data for DSEL.
    n_jobs : int, default=-1
        Number of parallel jobs.
    """

def classify_with_ds(self, predictions, probabilities=None,
                         competence_region=None, distances=None,
                         DFP_mask=None):
    """Predicts the label of the corresponding query sample.

    If self.mode == "selection", the selected ensemble is combined using
    the majority voting rule

    If self.mode == "weighting", all base classifiers are used for
    classification, however their influence in the final decision are
    weighted according to their estimated competence level. The weighted
    majority voting scheme is used to combine the decisions of the
    base classifiers.

    If self.mode == "hybrid",  A hybrid Dynamic selection and weighting
    approach is used. First an ensemble with the competent base classifiers
    are selected. Then, their decisions are aggregated using the weighted
    majority voting rule according to its competence level estimates.

    Parameters
    ----------
    predictions : array of shape (n_samples, n_classifiers)
                    Predictions of the base classifier for all test examples.

    probabilities : array of shape (n_samples, n_classifiers, n_classes)
        Probabilities estimates of each base classifier for all test
        examples. (For methods that always require probabilities from
        the base classifiers).

    competence_region : array of shape (n_samples, n_neighbors)
        Indices of the k nearest neighbors according for each test sample.

    distances : array of shape (n_samples, n_neighbors)
                    Distances from the k nearest neighbors to the query

    DFP_mask : array of shape (n_samples, n_classifiers)
        Mask containing 1 for the selected base classifier and 0 otherwise.

    Returns
    -------
    predicted_label : array of shape (n_samples)
                        Predicted class label for each test example.
    """

def predict_proba_with_ds(self, predictions, probabilities=None,
                              competence_region=None, distances=None,
                              DFP_mask=None):
    """Predicts the posterior probabilities of the corresponding query.

        If self.mode == "selection", the selected ensemble is used to estimate
        the probabilities. The average rule is used
        to give probabilities estimates.

        If self.mode == "weighting", all base classifiers are used for
        estimating the probabilities, however their influence in the final
        decision are weighted according to their estimated competence level.
        A weighted average method is used to give the probabilities estimates.

        If self.mode == "Hybrid",  A hybrid Dynamic selection and weighting
        approach is used. First an ensemble with the competent base classifiers
        are selected. Then, their decisions are aggregated using a weighted
        average rule to give the probabilities estimates.

        Parameters
        ----------
        predictions : array of shape (n_samples, n_classifiers)
            Predictions of the base classifier for all test examples.

        probabilities : array of shape (n_samples, n_classifiers, n_classes)
            Probabilities estimates of each base classifier for all samples.

        competence_region : array of shape (n_samples, n_neighbors)
            Indices of the k nearest neighbors.
        distances : array of shape (n_samples, n_neighbors)
            Distances from the k nearest neighbors to the query

        DFP_mask : array of shape (n_samples, n_classifiers)
            Mask containing 1 for the selected base classifier and 0 otherwise.

        Returns
        -------
        predicted_proba : array = [n_samples, n_classes]
                          The probability estimates for all test examples.
        """

def _dynamic_selection(self, competences, predictions, probabilities):
    """ Combine models using dynamic ensemble selection. 

    Parameters
    ----------
    competences : array of shape (n_samples, n_classifiers)
        Competence estimates for each classifier.
    predictions : array of shape (n_samples, n_classifiers)
        Predictions from base classifiers.
    probabilities : array of shape (n_samples, n_classifiers, n_classes)
        Probabilities from base classifiers.

    Returns
    -------
    selected_predictions : array of shape (n_samples)
        Predictions from selected classifiers.
    """

def _dynamic_weighting(self, competences, predictions, probabilities):
    """Perform dynamic weighting of classifiers.

    Parameters
    ----------
    competences : array of shape (n_samples, n_classifiers)
        Competence estimates for each classifier.
    predictions : array of shape (n_samples, n_classifiers)
        Predictions from base classifiers.
    probabilities : array of shape (n_samples, n_classifiers, n_classes)
        Probabilities from base classifiers.

    Returns
    -------
    weighted_predictions : array of shape (n_samples)
        Weighted predictions from classifiers.
    """

def _hybrid(self, competences, predictions, probabilities):
    """Combine models using a hybrid dynamic selection + weighting.

    Parameters
    ----------
    competences : array of shape (n_samples, n_classifiers)
        Competence estimates for each classifier.
    predictions : array of shape (n_samples, n_classifiers)
        Predictions from base classifiers.
    probabilities : array of shape (n_samples, n_classifiers, n_classes)
        Probabilities from base classifiers.

    Returns
    -------
    hybrid_predictions : array of shape (n_samples)
        Hybrid predictions combining selection and weighting.
    """

@staticmethod
def _mask_proba(probabilities, selected_classifiers):
    """Mask the probability estimates to only include selected classifiers.

    Parameters
    ----------
    probabilities : array of shape (n_samples, n_classifiers, n_classes)
        Probability estimates from all classifiers.
    selected_classifiers : array of shape (n_samples, n_classifiers)
        Boolean mask indicating selected classifiers.

    Returns
    -------
    masked_probabilities : array of shape (n_samples, n_classifiers, n_classes)
        Probability estimates with non-selected classifiers masked to zero.
    """

def _validate_parameters(self):
    """Validate the input parameters for BaseDES.
    
    Checks mode and voting parameters are valid.
    """
```

**Additional Parameters**:
- `mode` (str): Selection mode ('selection', 'weighting', 'hybrid'), default is 'selection'
- `voting` (str): Voting method ('hard' or 'soft'), default is 'hard'

#### 36. KNORAU Class - K-Nearest Oracles Union

**Import Statement**:
```python
from deslib.des.knora_u import KNORAU
```

**Function**: K-Nearest Oracles Union (KNORA-U) dynamic ensemble selection method that selects all classifiers that correctly classify at least one sample in the region of competence.

**Class Definition**:
```python
class KNORAU(BaseDES):
    """k-Nearest Oracles Union (KNORA-U).

    This method selects all classifiers that correctly classified at least
    one sample belonging to the region of competence of the query sample. Each
    selected classifier has a number of votes equals to the number of samples
    in the region of competence that it predicts the correct label. The votes
    obtained by all base classifiers are aggregated to obtain the final
    ensemble decision.

    Parameters
    ----------
     pool_classifiers : list of classifiers (Default = None)
        The generated_pool of classifiers trained for the corresponding
        classification problem. Each base classifiers should support the method
        "predict". If None, then the pool of classifiers is a bagging
        classifier.

    k : int (Default = 7)
        Number of neighbors used to estimate the competence of the base
        classifiers.

    DFP : Boolean (Default = False)
        Determines if the dynamic frienemy pruning is applied.

    with_IH : Boolean (Default = False)
        Whether the hardness level of the region of competence is used to
        decide between using the DS algorithm or the KNN for classification of
        a given query sample.

    safe_k : int (default = None)
        The size of the indecision region.

    IH_rate : float (default = 0.3)
        Hardness threshold. If the hardness level of the competence region is
        lower than the IH_rate the KNN classifier is used. Otherwise, the DS
        algorithm is used for classification.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    knn_classifier : {'knn', 'faiss', None} (Default = 'knn')
         The algorithm used to estimate the region of competence:

         - 'knn' will use :class:`KNeighborsClassifier` from sklearn
          :class:`KNNE` available on `deslib.utils.knne`

         - 'faiss' will use Facebook's Faiss similarity search through the
           class :class:`FaissKNNClassifier`

         - None, will use sklearn :class:`KNeighborsClassifier`.

    knn_metric : {'minkowski', 'cosine', 'mahalanobis'} (Default = 'minkowski')
        The metric used by the k-NN classifier to estimate distances.

        - 'minkowski' will use minkowski distance.

        - 'cosine' will use the cosine distance.

        - 'mahalanobis' will use the mahalonibis distance.

    knne : bool (Default=False)
        Whether to use K-Nearest Neighbor Equality (KNNE) for the region
        of competence estimation.

    DSEL_perc : float (Default = 0.5)
        Percentage of the input data used to fit DSEL.
        Note: This parameter is only used if the pool of classifier is None or
        unfitted.

    voting : {'hard', 'soft'}, default='hard'
            If 'hard', uses predicted class labels for majority rule voting.
            Else if 'soft', predicts the class label based on the argmax of
            the sums of the predicted probabilities, which is recommended for
            an ensemble of well-calibrated classifiers.

    n_jobs : int, default=-1
        The number of parallel jobs to run. None means 1 unless in
        a joblib.parallel_backend context. -1 means using all processors.
        Doesn’t affect fit method.

    References
    ----------
    Ko, Albert HR, Robert Sabourin, and Alceu Souza Britto Jr.
    "From dynamic classifier selection to dynamic ensemble
    selection." Pattern Recognition 41.5 (2008): 1718-1731.

    Britto, Alceu S., Robert Sabourin, and Luiz ES Oliveira.
    "Dynamic selection of classifiers—a comprehensive review."
    Pattern Recognition 47.11 (2014): 3665-3680.

    R. M. O. Cruz, R. Sabourin, and G. D. Cavalcanti, “Dynamic classifier
    selection: Recent advances and perspectives,”
    In
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=7, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, random_state=None, voting='hard',
             knn_classifier='knn', knn_metric='minkowski', knne=False,
             DSEL_perc=0.5, n_jobs=-1):
    """Initialize the KNORAU classifier."""

def estimate_competence(self, competence_region, distances=None,
                            predictions=None):
    """Estimate the competence of base classifiers for KNORA-U.
    
    The competence is estimated as 1 if the classifier correctly
    classifies at least one sample in the region of competence,
    0 otherwise.

    Parameters
    ----------
    competence_region : array of shape (n_samples, n_neighbors)
        Indices of samples in the competence region.
    distances : array of shape (n_samples, n_neighbors), optional
        Distances to the neighbors (not used).
    predictions : array of shape (n_samples, n_classifiers), optional
        Predictions from base classifiers (not used).

    Returns
    -------
    competences : array of shape (n_samples, n_classifiers)
        Competence estimates (0 or 1) for each classifier.
    """

def select(self, competences):
    """Select all classifiers with competence > 0.

    Parameters
    ----------
    competences : array of shape (n_samples, n_classifiers)
        Competence estimates for each classifier.

    Returns
    -------
    selected_classifiers : array of shape (n_samples, n_classifiers)
        Boolean mask indicating selected classifiers.
    """
```

**Parameter Description**:
- `pool_classifiers` (list): List of base classifiers, default is None
- `k` (int): Number of neighbors, default is 7
- `DFP` (bool): Whether to use Dynamic Frienemy Pruning, default is False
- `with_IH` (bool): Whether to use Instance Hardness, default is False
- `safe_k` (int): Safe k value for IH, default is None
- `IH_rate` (float): Instance Hardness rate, default is 0.30
- `random_state` (int): Random state for reproducibility, default is None
- `voting` (str): Voting method ('hard', 'soft'), default is 'hard'
- `knn_classifier` (str): KNN classifier type, default is 'knn'
- `knn_metric` (str): Distance metric for KNN, default is 'minkowski'
- `knne` (bool): Whether to use KNNE, default is False
- `DSEL_perc` (float): Percentage of data for DSEL, default is 0.5
- `n_jobs` (int): Number of parallel jobs, default is -1

#### 37. DESP Class - Dynamic Ensemble Selection Performance

**Import Statement**:
```python
from deslib.des.des_p import DESP
```

**Function**: Dynamic Ensemble Selection Performance (DES-P) method that selects classifiers based on their performance in the local region.

**Class Definition**:
```python
class DESP(BaseDES):
    """Dynamic ensemble selection-Performance(DES-P).

    This method selects all base classifiers that achieve a classification
    performance, in the region of competence, that is higher than the random
    classifier (RC). The performance of the random classifier is defined by
    RC = 1/L, where L is the number of classes in the problem.
    If no base classifier is selected, the whole pool is used for
    classification.

    Parameters
    ----------
     pool_classifiers : list of classifiers (Default = None)
        The generated_pool of classifiers trained for the corresponding
        classification problem. Each base classifiers should support the method
        "predict". If None, then the pool of classifiers is a bagging
        classifier.

    k : int (Default = 7)
        Number of neighbors used to estimate the competence of the base
        classifiers.

    DFP : Boolean (Default = False)
        Determines if the dynamic frienemy pruning is applied.

    with_IH : Boolean (Default = False)
        Whether the hardness level of the region of competence is used to
        decide between using the DS algorithm or the KNN for classification of
        a given query sample.

    safe_k : int (default = None)
        The size of the indecision region.

    IH_rate : float (default = 0.3)
        Hardness threshold. If the hardness level of the competence region is
        lower than the IH_rate the KNN classifier is used. Otherwise, the DS
        algorithm is used for classification.


    mode : String (Default = "selection")
           Whether the technique will perform dynamic selection,
           dynamic weighting or an hybrid approach for classification.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    knn_classifier : {'knn', 'faiss', None} (Default = 'knn')
         The algorithm used to estimate the region of competence:

         - 'knn' will use :class:`KNeighborsClassifier` from sklearn
          :class:`KNNE` available on `deslib.utils.knne`

         - 'faiss' will use Facebook's Faiss similarity search through the
           class :class:`FaissKNNClassifier`

         - None, will use sklearn :class:`KNeighborsClassifier`.

    knn_metric : {'minkowski', 'cosine', 'mahalanobis'} (Default = 'minkowski')
        The metric used by the k-NN classifier to estimate distances.

        - 'minkowski' will use minkowski distance.

        - 'cosine' will use the cosine distance.

        - 'mahalanobis' will use the mahalonibis distance.

    knne : bool (Default=False)
        Whether to use K-Nearest Neighbor Equality (KNNE) for the region
        of competence estimation.

    DSEL_perc : float (Default = 0.5)
        Percentage of the input data used to fit DSEL.
        Note: This parameter is only used if the pool of classifier is None or
        unfitted.

    voting : {'hard', 'soft'}, default='hard'
            If 'hard', uses predicted class labels for majority rule voting.
            Else if 'soft', predicts the class label based on the argmax of
            the sums of the predicted probabilities, which is recommended for
            an ensemble of well-calibrated classifiers.

    n_jobs : int, default=-1
        The number of parallel jobs to run. None means 1 unless in
        a joblib.parallel_backend context. -1 means using all processors.
        Doesn’t affect fit method..

    References
    ----------
    Woloszynski, Tomasz, et al. "A measure of competence based on random
    classification for dynamic ensemble selection."
    Information Fusion 13.3 (2012): 207-213.

    Woloszynski, Tomasz, and Marek Kurzynski. "A probabilistic model of
    classifier competence for dynamic ensemble selection."
    Pattern Recognition 44.10 (2011): 2656-2668.

    R. M. O. Cruz, R. Sabourin, and G. D. Cavalcanti, “Dynamic classifier
    selection: Recent advances and perspectives,”
    Information Fusion, vol. 41, pp. 195 – 216, 2018.
    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=7, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, mode='selection', random_state=None,
             knn_classifier='knn', knn_metric='minkowski', knne=False,
             DSEL_perc=0.5, n_jobs=-1, voting='hard'):
    """Initialize the DESP classifier."""

def estimate_competence(self, competence_region, distances=None,
                            predictions=None):
    """estimate the competence of each base classifier :math:`c_{i}` for
    the classification of the query sample base on its local performance.

    .. math:: \\delta_{i,j} =  \\hat{P}(c_{i} \\mid \\theta_{j} )
        - \\frac{1}{L}

    Parameters
    ----------
    competence_region : array of shape (n_samples, n_neighbors)
        Indices of the k nearest neighbors according for each test sample.

    distances : array of shape (n_samples, n_neighbors)
        Distances from the k nearest neighbors to the query.

    predictions : array of shape (n_samples, n_classifiers)
        Predictions of the base classifiers for all test examples.

    Returns
    -------
    competences : array of shape (n_samples, n_classifiers)
        Competence level estimated for each base classifier and test
        example.
    """

def select(self, competences):
    """Selects all base classifiers that obtained a local classification
    accuracy higher than the Random Classifier. The performance of the
    random classifier is denoted 1/L, where L is the number of classes
    in the problem.

    Parameters
    ----------
    competences : array of shape (n_samples, n_classifiers)
        Competence level estimated for each base classifier and test
        example.

    Returns
    -------
    selected_classifiers : array of shape (n_samples, n_classifiers)
        Boolean matrix containing True if the base classifier is selected,
        False otherwise.

    """
```

**Parameter Description**:
- `pool_classifiers` (list): List of base classifiers, default is None
- `k` (int): Number of neighbors, default is 7
- `DFP` (bool): Whether to use Dynamic Frienemy Pruning, default is False
- `with_IH` (bool): Whether to use Instance Hardness, default is False
- `safe_k` (int): Safe k value for IH, default is None
- `IH_rate` (float): Instance Hardness rate, default is 0.30
- `mode` (str): Selection mode ('selection', 'weighting', 'hybrid'), default is 'selection'
- `random_state` (int): Random state for reproducibility, default is None
- `knn_classifier` (str): KNN classifier type, default is 'knn'
- `knn_metric` (str): Distance metric for KNN, default is 'minkowski'
- `knne` (bool): Whether to use KNNE, default is False
- `DSEL_perc` (float): Percentage of data for DSEL, default is 0.5
- `n_jobs` (int): Number of parallel jobs, default is -1
- `voting` (str): Voting method ('hard', 'soft'), default is 'hard'

#### 38. DESKNN Class - Dynamic Ensemble Selection K-Nearest Neighbors

**Import Statement**:
```python
from deslib.des.des_knn import DESKNN
```

**Function**: Dynamic Ensemble Selection K-Nearest Neighbors method that combines accuracy and diversity measures for classifier selection.

**Class Definition**:
```python
class DESKNN(BaseDS):
    """Dynamic ensemble Selection KNN (DES-KNN).

    This method selects an ensemble of classifiers taking into account the
    accuracy and diversity of the base classifiers. The k-NN algorithm is used
    to define the region of competence. The N most accurate classifiers in the
    region of competence are first selected. Then, the J more diverse
    classifiers from the N most accurate classifiers are selected to compose
    the ensemble.

    Parameters
    ----------
     pool_classifiers : list of classifiers (Default = None)
        The generated_pool of classifiers trained for the corresponding
        classification problem. Each base classifiers should support the method
        "predict". If None, then the pool of classifiers is a bagging
        classifier.

    k : int (Default = 7)
        Number of neighbors used to estimate the competence of the base
        classifiers.

    DFP : Boolean (Default = False)
        Determines if the dynamic frienemy pruning is applied.

    with_IH : Boolean (Default = False)
        Whether the hardness level of the region of competence is used to
        decide between using the DS algorithm or the KNN for classification of
        a given query sample.

    safe_k : int (default = None)
        The size of the indecision region.

    IH_rate : float (default = 0.3)
        Hardness threshold. If the hardness level of the competence region is
        lower than the IH_rate the KNN classifier is used. Otherwise, the DS
        algorithm is used for classification.

    pct_accuracy : float (Default = 0.5)
                   Percentage of base classifiers selected based on accuracy

    pct_diversity : float (Default = 0.3)
                    Percentage of base classifiers selected based n diversity

    more_diverse : Boolean (Default = True)
        Whether we select the most or the least diverse classifiers to add
        to the pre-selected ensemble

    metric : String (Default = 'df')
        Metric used to estimate the diversity of the base classifiers. Can be
        either the double fault (df), Q-statistics (Q), or error correlation.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    knn_classifier : {'knn', 'faiss', None} (Default = 'knn')
         The algorithm used to estimate the region of competence:

         - 'knn' will use :class:`KNeighborsClassifier` from sklearn
          :class:`KNNE` available on `deslib.utils.knne`

         - 'faiss' will use Facebook's Faiss similarity search through the
           class :class:`FaissKNNClassifier`

         - None, will use sklearn :class:`KNeighborsClassifier`.

    knn_metric : {'minkowski', 'cosine', 'mahalanobis'} (Default = 'minkowski')
        The metric used by the k-NN classifier to estimate distances.

        - 'minkowski' will use minkowski distance.

        - 'cosine' will use the cosine distance.

        - 'mahalanobis' will use the mahalonibis distance.

    knne : bool (Default=False)
        Whether to use K-Nearest Neighbor Equality (KNNE) for the region
        of competence estimation.

    DSEL_perc : float (Default = 0.5)
        Percentage of the input data used to fit DSEL.
        Note: This parameter is only used if the pool of classifier is None or
        unfitted.

    voting : {'hard', 'soft'}, default='hard'
            If 'hard', uses predicted class labels for majority rule voting.
            Else if 'soft', predicts the class label based on the argmax of
            the sums of the predicted probabilities, which is recommended for
            an ensemble of well-calibrated classifiers.

    n_jobs : int, default=-1
        The number of parallel jobs to run. None means 1 unless in
        a joblib.parallel_backend context. -1 means using all processors.
        Doesn’t affect fit method.

    References
    ----------
    Soares, R. G., Santana, A., Canuto, A. M., & de Souto, M. C. P.
    "Using accuracy and more_diverse to select classifiers to build ensembles."
    International Joint Conference on Neural Networks (IJCNN)., 2006.

    Britto, Alceu S., Robert Sabourin, and Luiz ES Oliveira. "Dynamic selection
    of classifiers—a comprehensive review."
    Pattern Recognition 47.11 (2014): 3665-3680.

    R. M. O. Cruz, R. Sabourin, and G. D. Cavalcanti, “Dynamic classifier
    selection: Recent advances and perspectives,”
    Information Fusion, vol. 41, pp. 195 – 216, 2018.
    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=7, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, pct_accuracy=0.5, pct_diversity=0.3,
             more_diverse=True, metric='DF', random_state=None,
             knn_classifier='knn', knn_metric='minkowski', knne=False,
             DSEL_perc=0.5, n_jobs=-1, voting='hard'):
    """Initialize the DESKNN classifier.
    
    Parameters
    ----------
    pool_classifiers : list, default=None
        List of base classifiers.
    k : int, default=7
        Number of neighbors.
    DFP : bool, default=False
        Whether to use Dynamic Frienemy Pruning.
    with_IH : bool, default=False
        Whether to use Instance Hardness.
    safe_k : int, default=None
        Safe k value for IH.
    IH_rate : float, default=0.30
        Instance Hardness rate.
    pct_accuracy : float, default=0.5
        Percentage of classifiers selected based on accuracy.
    pct_diversity : float, default=0.33
        Percentage of classifiers selected based on diversity.
    more_diverse : bool, default=True
        Whether to select more diverse classifiers.
    metric : str, default='DF'
        Diversity metric ('DF', 'Q', 'ratio').
    random_state : int, default=None
        Random state for reproducibility.
    knn_classifier : str, default='knn'
        KNN classifier type.
    knn_metric : str, default='minkowski'
        Distance metric for KNN.
    knne : bool, default=False
        Whether to use KNNE.
    DSEL_perc : float, default=0.5
        Percentage of data for DSEL.
    n_jobs : int, default=-1
        Number of parallel jobs.
    voting : str, default='hard'
        Voting method ('hard', 'soft').
    """

def fit(self, X, y):
    """Train the DES-KNN classifier.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        The input data.
    y : array of shape (n_samples)
        Class labels of each example in X.

    Returns
    -------
    self
    """

def estimate_competence(self, competence_region, distances=None,
                            predictions=None):
    """estimate the competence level of each base classifier :math:`c_{i}`
        for the classification of the query sample.

        The competence is estimated using the accuracy and diversity criteria.
        First the classification accuracy of the base classifiers in the
        region of competence is estimated. Then the diversity of the
        base classifiers is estimated.

        The method returns two arrays: One containing the accuracy and the
        other the diversity of each base classifier.

        Parameters
        ----------
        competence_region : array of shape (n_samples, n_neighbors)
            Indices of the k nearest neighbors according for each test sample.

        distances : array of shape (n_samples, n_neighbors)
                        Distances from the k nearest neighbors to the query


        predictions : array of shape (n_samples, n_classifiers)
            Predictions of the base classifiers for all test examples.

        Notes
        ------
        This technique uses both the accuracy and diversity information to
        perform dynamic selection. For this reason the function returns a
        dictionary containing these two values instead of a single ndarray
        containing the competence level estimates for each base classifier.

        Returns
        -------
        accuracy : array of shape = [n_samples, n_classifiers}
                   Local Accuracy estimates (competences) of the base
                   classifiers for all query samples.

        diversity : array of shape = [n_samples, n_classifiers}
                    Average pairwise diversity of each base classifiers for
                    all test examples.

        """

def select(self, accuracy, diversity):
    """Select an ensemble containing the N most accurate and the J most
    diverse classifiers for the classification of the query sample.

    Parameters
    ----------
    accuracy : array of shape (n_samples, n_classifiers)
        Local Accuracy estimates (competence) of each base classifiers.

    diversity : array of shape (n_samples, n_classifiers)
                Average pairwise diversity of each base classifiers.

    Returns
    -------
    selected_classifiers : array of shape = [n_samples, self.J]
        Array containing the indices of the J selected base classifier
        for each test example.
    """

def classify_with_ds(self, predictions, pprobabilities=None,
                         neighbors=None, distances=None, DFP_mask=None):
    """Predicts the label of the corresponding query sample.

        Parameters
        ----------
        predictions : array of shape (n_samples, n_classifiers)
                      Predictions of the base classifiers for all test examples

        probabilities : array of shape (n_samples, n_classifiers, n_classes)
            Probabilities estimates of each base classifier for all test
            examples.

        neighbors : array of shape (n_samples, n_neighbors)
            Indices of the k nearest neighbors according for each test sample.

        distances : array of shape (n_samples, n_neighbors)
                        Distances from the k nearest neighbors to the query

        DFP_mask : array of shape (n_samples, n_classifiers)
            Mask containing 1 for the selected base classifier and 0 otherwise.

        Notes
        ------
        Different than other DES techniques, this method is based on a two
        stage selection, where first the most accurate classifier are selected,
        then the diversity information is used to get the most diverse ensemble
        for the probability estimation. Hence, the weighting mode is not
        defined. Also, the selected ensemble size is fixed (self.J), so there
        is no need to use masked arrays in this class.

        Returns
        -------
        predicted_label : array of shape (n_samples)
                          Predicted class label for each test example.
        """

def predict_proba_with_ds(self, predictions, probabilities,  neighbors=None, distances=None, DFP_mask=None):
     """Predicts the posterior probabilities.

        Parameters
        ----------
        predictions : array of shape (n_samples, n_classifiers)
            Predictions of the base classifiers for all test examples.

        probabilities : array of shape (n_samples, n_classifiers, n_classes)
            Probabilities estimates of each base classifier for all test
            examples.

        neighbors : array of shape (n_samples, n_neighbors)
            Indices of the k nearest neighbors.

        distances : array of shape (n_samples, n_neighbors)
            Distances from the k nearest neighbors to the query.

        DFP_mask : array of shape (n_samples, n_classifiers)
            Mask containing 1 for the selected base classifier and 0 otherwise.

        Notes
        ------
        Different than other DES techniques, this method is based on a two
        stage selection, where first the most accurate classifier are selected,
        then the diversity information is used to get the most diverse ensemble
        for the probability estimation. Hence, the weighting mode is not
        available.

        Returns
        -------
        predicted_proba : array = [n_samples, n_classes]
                          Probability estimates for all test examples.
        """

def _check_parameters(self):
    """Check if the parameters passed as argument are correct.

    Raises
    ------
    ValueError
        If the hyper-parameters are incorrect.
    """

def _set_diversity_func(self):
    """Set the diversity function to be used according to the
    hyper-parameter metric

    The diversity_func_ can be either the Double Fault, Q-Statistics
    or Ratio of errors.
    ----------
    """
```

**Parameter Description**:
- `pool_classifiers` (list): List of base classifiers, default is None
- `k` (int): Number of neighbors, default is 7
- `DFP` (bool): Whether to use Dynamic Frienemy Pruning, default is False
- `with_IH` (bool): Whether to use Instance Hardness, default is False
- `safe_k` (int): Safe k value for IH, default is None
- `IH_rate` (float): Instance Hardness rate, default is 0.30
- `pct_accuracy` (float): Percentage of classifiers selected based on accuracy, default is 0.5
- `pct_diversity` (float): Percentage of classifiers selected based on diversity, default is 0.33
- `more_diverse` (bool): Whether to select more diverse classifiers, default is True
- `metric` (str): Diversity metric ('DF', 'Q', 'ratio'), default is 'DF'
- `random_state` (int): Random state for reproducibility, default is None
- `knn_classifier` (str): KNN classifier type, default is 'knn'
- `knn_metric` (str): Distance metric for KNN, default is 'minkowski'
- `knne` (bool): Whether to use KNNE, default is False
- `DSEL_perc` (float): Percentage of data for DSEL, default is 0.5
- `n_jobs` (int): Number of parallel jobs, default is -1
- `voting` (str): Voting method ('hard', 'soft'), default is 'hard'

#### 39. DESClustering Class - Dynamic Ensemble Selection Clustering

**Import Statement**:
```python
from deslib.des.des_clustering import DESClustering
```

**Function**: Dynamic Ensemble Selection using clustering approach that groups similar samples and selects classifiers for each cluster.

**Class Definition**:
```python
class DESClustering(BaseDS):
     """Dynamic ensemble selection-Clustering (DES-Clustering).

    This method selects an ensemble of classifiers taking into account the
    accuracy and diversity of the base classifiers. The K-means algorithm is
    used to define the region of competence. For each cluster, the N most
    accurate classifiers are first selected. Then, the J more diverse
    classifiers from the N most accurate classifiers are selected to
    compose the ensemble.

    Parameters
    ----------
     pool_classifiers : list of classifiers (Default = None)
        The generated_pool of classifiers trained for the corresponding
        classification problem. Each base classifiers should support the method
        "predict". If None, then the pool of classifiers is a bagging
        classifier.

    clustering : sklearn.cluster (Default = None)
        The clustering model used to estimate the region of competence.
        If None, a KMeans with K = 5 is used.

    pct_accuracy : float (Default = 0.5)
                   Percentage of base classifiers selected based on accuracy

    pct_diversity : float (Default = 0.33)
                    Percentage of base classifiers selected based on diversity

    more_diverse : Boolean (Default = True)
                   Whether we select the most or the least diverse classifiers
                   to add to the pre-selected ensemble

    metric_diversity : String (Default = 'df')
        Metric used to estimate the diversity of the base classifiers. Can be
        either the double fault (df), Q-statistics (Q), or error correlation.

    metric_performance : String (Default = 'accuracy_score')
        Metric used to estimate the performance of a base classifier on a
        cluster. Can be either any metric from sklearn.metrics.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    DSEL_perc : float (Default = 0.5)
        Percentage of the input data used to fit DSEL.
        Note: This parameter is only used if the pool of classifier is None or
        unfitted.

    voting : {'hard', 'soft'}, default='hard'
            If 'hard', uses predicted class labels for majority rule voting.
            Else if 'soft', predicts the class label based on the argmax of
            the sums of the predicted probabilities, which is recommended for
            an ensemble of well-calibrated classifiers.

    n_jobs : int, default=-1
        The number of parallel jobs to run. None means 1 unless in
        a joblib.parallel_backend context. -1 means using all processors.
        Doesn’t affect fit method.

    References
    ----------
    Soares, R. G., Santana, A., Canuto, A. M., & de Souto, M. C. P.
    "Using accuracy and more_diverse to select classifiers to build ensembles."
    International Joint Conference on Neural Networks (IJCNN)., 2006.

    Britto, Alceu S., Robert Sabourin, and Luiz ES Oliveira. "Dynamic selection
    of classifiers—a comprehensive review."
    Pattern Recognition 47.11 (2014): 3665-3680.

    R. M. O. Cruz, R. Sabourin, and G. D. Cavalcanti, “Dynamic classifier
    selection: Recent advances and perspectives,”
    Information Fusion, vol. 41, pp. 195 – 216, 2018.
    """

```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, clustering=None, pct_accuracy=0.5,
             voting='hard', pct_diversity=0.33, more_diverse=True,
             metric_diversity='DF', metric_performance='accuracy_score',
             n_clusters=5, random_state=None, DSEL_perc=0.5, n_jobs=-1):
    """Initialize the DESClustering classifier.
    
    Parameters
    ----------
    pool_classifiers : list, default=None
        List of base classifiers.
    clustering : clustering algorithm, default=None
        Clustering algorithm instance.
    pct_accuracy : float, default=0.5
        Percentage based on accuracy.
    voting : str, default='hard'
        Voting method ('hard', 'soft').
    pct_diversity : float, default=0.33
        Percentage based on diversity.
    more_diverse : bool, default=True
        Whether to select more diverse classifiers.
    metric_diversity : str, default='DF'
        Diversity metric.
    metric_performance : str, default='accuracy_score'
        Performance metric.
    n_clusters : int, default=5
        Number of clusters.
    random_state : int, default=None
        Random state for reproducibility.
    DSEL_perc : float, default=0.5
        Percentage of data for DSEL.
    n_jobs : int, default=-1
        Number of parallel jobs.
    """

def fit(self, X, y):
    """Train the DES-Clustering classifier.
    
    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        The input data.
    y : array of shape (n_samples)
        Class labels of each example in X.
    
    Returns
    -------
    self
    """

def get_competence_region(self, query, k=None):
    """Get competence region using clustering.
    
    Parameters
    ----------
    query : array of shape (n_samples, n_features)
        Query samples.
    k : int
        Number of neighbors (not used in clustering approach).
    
    Returns
    -------
    distances : array
        Distances to cluster centers.
    indices : array
        Cluster assignments.
    """

def _preprocess_clusters(self):
    """Preprocess cluster information.
    
    Computes cluster-specific information for classifier selection.
    """

def estimate_competence(self, competence_region, distances=None,
                            predictions=None):
    """Get the competence estimates of each base classifier :math:`c_{i}`
    for the classification of the query sample.

    In this case, the competences were already pre-calculated for each
    cluster. So this method computes the nearest cluster and get the
    pre-calculated competences of the base classifiers for the
    corresponding cluster.

    Parameters
    ----------
    predictions : array of shape (n_samples, n_classifiers)
        Predictions of the base classifiers for all test examples.

    Returns
    -------
    competences : array = [n_samples, n_classifiers]
                    The competence level estimated for each base classifier.
    """

def select(self, competences):
    """Select an ensemble with the most accurate and most diverse
    classifier for the classification of the query.

    The ensemble for each cluster was already pre-calculated in the fit
    method. So, this method calculates the closest cluster, and returns
    the ensemble associated to this cluster.

    Parameters
    ----------
    competences : array of shape (n_samples)
        Array containing closest cluster index.

    Returns
    -------
    selected_classifiers : array of shape = [n_samples, self.k]
        Indices of the selected base classifier for each test example.

    """
def classify_with_ds(self, predictions, probabilities=None,
                         competence_region=None, distances=None,
                         DFP_mask=None):
        """Predicts the label of the corresponding query sample.

        Parameters
        ----------
        predictions : array of shape (n_samples, n_classifiers)
            Predictions of the base classifiers for all test examples.

        probabilities : array of shape (n_samples, n_classifiers, n_classes)
            Probabilities estimates of each base classifier for all test
            examples.

        competence_region : array of shape (n_samples)
            Indices of the nearest clusters to each sample.

        distances : array of shape (n_samples)
            Distances of the nearest clusters to each sample.

        DFP_mask : array of shape (n_samples, n_classifiers)
            Mask containing 1 for the selected base classifier and 0 otherwise.

        Returns
        -------
        predicted_label : array of shape (n_samples)
                          Predicted class label for each test example.
        """
        proba = self.predict_proba_with_ds(predictions, probabilities,
                                           competence_region, distances,
                                           DFP_mask)
        predicted_label = proba.argmax(axis=1)
        return predicted_label

def predict_proba_with_ds(self, predictions, probabilities,
                            competence_region=None, distances=None,
                            DFP_mask=None):
    """Predicts the label of the corresponding query sample.

    Parameters
    ----------
    predictions : array of shape (n_samples, n_classifiers)
        Predictions of the base classifiers for all test examples.

    probabilities : array of shape (n_samples, n_classifiers, n_classes)
        Probabilities estimates of each base classifier for all test
        examples.

    competence_region : array of shape (n_samples)
        Indices of the nearest clusters to each sample.

    distances : array of shape (n_samples)
        Distances of the nearest clusters to each sample.

    DFP_mask : array of shape (n_samples, n_classifiers)
        Mask containing 1 for the selected base classifier and 0 otherwise.

    Returns
    -------
    predicted_proba : array of shape (n_samples, n_classes)
        Posterior probabilities estimates for each test example.
    """
def _check_parameters(self):
    """Check if the parameters passed as argument are correct.

    Raises
    ------
    ValueError
        If the hyper-parameters are incorrect.
    """    
def get_scores_(self, sample_indices):
    """Get performance scores for samples.
    
    Parameters
    ----------
    sample_indices : array
        Indices of samples.
    
    Returns
    -------
    scores : array
        Performance scores.
    """

def _set_diversity_func(self):
    """Set the diversity function to be used according to the
    hyper-parameter metric_diversity

    The diversity_func_ can be either the Double Fault, Q-Statistics
    or Ratio of errors.

    """
```

**Parameter Description**:
- `pool_classifiers` (list): List of base classifiers, default is None
- `clustering`: Clustering algorithm instance, default is None
- `pct_accuracy` (float): Percentage based on accuracy, default is 0.5
- `voting` (str): Voting method ('hard', 'soft'), default is 'hard'
- `pct_diversity` (float): Percentage based on diversity, default is 0.33
- `more_diverse` (bool): Whether to select more diverse classifiers, default is True
- `metric_diversity` (str): Diversity metric, default is 'DF'
- `metric_performance` (str): Performance metric, default is 'accuracy_score'
- `n_clusters` (int): Number of clusters, default is 5
- `random_state` (int): Random state for reproducibility, default is None
- `DSEL_perc` (float): Percentage of data for DSEL, default is 0.5
- `n_jobs` (int): Number of parallel jobs, default is -1

#### 40. METADES Class - Meta-Learning Dynamic Ensemble Selection

**Import Statement**:
```python
from deslib.des.meta_des import METADES
```

**Function**: Meta-Learning Dynamic Ensemble Selection method that uses a meta-classifier to decide which base classifiers to select.

**Class Definition**:
```python
class METADES(BaseDES):
    """Meta learning for dynamic ensemble selection (META-DES).

    The META-DES framework is based on the assumption that the dynamic ensemble
    selection problem can be considered as a meta-problem. This meta-problem
    uses different criteria regarding the behavior of a base classifier
    :math:`c_{i}`, in order to decide whether it is competent enough to
    classify a given test sample.

    The framework performs a meta-training stage, in which, the meta-features
    are extracted from each instance belonging to the training and the dynamic
    selection dataset (DSEL). Then, the extracted meta-features are used
    to train the meta-classifier :math:`\\lambda`. The meta-classifier is
    trained to predict whether or not a base classifier :math:`c_{i}` is
    competent enough to classify a given input sample.

    When an unknown sample is presented to the system, the meta-features for
    each base classifier :math:`c_{i}` in relation to the input sample are
    calculated and presented to the meta-classifier. The meta-classifier
    estimates the competence level of the base classifier :math:`c_{i}` for
    the classification of the query sample. Base classifiers with competence
    level higher than a pre-defined threshold are selected. If no base
    classifier is selected, the whole pool is used for classification.

    Parameters
    ----------
     pool_classifiers : list of classifiers (Default = None)
        The generated_pool of classifiers trained for the corresponding
        classification problem. Each base classifiers should support the method
        "predict". If None, then the pool of classifiers is a bagging
        classifier.

    meta_classifier :   sklearn.estimator (Default = None)
                        Classifier model used for the meta-classifier. If None,
                        a Multinomial naive Bayes classifier is used.

    k : int (Default = 7)
        Number of neighbors used to estimate the competence of the base
        classifiers.

    Kp : int (Default = 5)
         Number of output profiles used to estimate the competence of the
         base classifiers.

    Hc : float (Default = 1.0)
         Sample selection threshold.

    selection_threshold : float(Default = 0.5)
        Threshold used to select the base classifier. Only the base classifiers
        with competence level higher than the selection_threshold are selected
        to compose the ensemble.

    mode : String (Default = "selection")
        Determines the mode of META-des that is used
        (selection, weighting or hybrid).

    DFP : Boolean (Default = False)
        Determines if the dynamic frienemy pruning is applied.

    with_IH : Boolean (Default = False)
        Whether the hardness level of the region of competence is used to
        decide between using the DS algorithm or the KNN for classification of
        a given query sample.

    safe_k : int (default = None)
        The size of the indecision region.

    IH_rate : float (default = 0.3)
        Hardness threshold. If the hardness level of the competence region is
        lower than the IH_rate the KNN classifier is used. Otherwise, the DS
        algorithm is used for classification.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    knn_classifier : {'knn', 'faiss', None} (Default = 'knn')
         The algorithm used to estimate the region of competence:

         - 'knn' will use :class:`KNeighborsClassifier` from sklearn
          :class:`KNNE` available on `deslib.utils.knne`

         - 'faiss' will use Facebook's Faiss similarity search through the
           class :class:`FaissKNNClassifier`

         - None, will use sklearn :class:`KNeighborsClassifier`.

    knn_metric : {'minkowski', 'cosine', 'mahalanobis'} (Default = 'minkowski')
        The metric used by the k-NN classifier to estimate distances.

        - 'minkowski' will use minkowski distance.

        - 'cosine' will use the cosine distance.

        - 'mahalanobis' will use the mahalonibis distance.

        Note: This parameter only affects the neighborhood search applied in
        the feature space.

    knne : bool (Default=False)
        Whether to use K-Nearest Neighbor Equality (KNNE) for the region
        of competence estimation.

    DSEL_perc : float (Default = 0.5)
        Percentage of the input data used to fit DSEL.
        Note: This parameter is only used if the pool of classifier is None or
        unfitted.

    voting : {'hard', 'soft'}, default='hard'
            If 'hard', uses predicted class labels for majority rule voting.
            Else if 'soft', predicts the class label based on the argmax of
            the sums of the predicted probabilities, which is recommended for
            an ensemble of well-calibrated classifiers.

    n_jobs : int, default=-1
        The number of parallel jobs to run. None means 1 unless in
        a joblib.parallel_backend context. -1 means using all processors.
        Doesn’t affect fit method.

    References
    ----------
    Cruz, R.M., Sabourin, R., Cavalcanti, G.D. and Ren, T.I., 2015. META-DES:
    A dynamic ensemble selection framework using meta-learning.
    Pattern Recognition, 48(5), pp.1925-1935.

    Cruz, R.M., Sabourin, R. and Cavalcanti, G.D., 2015, July. META-des. H:
    a dynamic ensemble selection technique using meta-learning and a dynamic
    weighting approach. In Neural Networks (IJCNN), 2015 International Joint
    Conference on (pp. 1-8).

    R. M. O. Cruz, R. Sabourin, and G. D. Cavalcanti, “Dynamic classifier
    selection: Recent advances and perspectives,”
    Information Fusion, vol. 41, pp. 195 – 216, 2018.

    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, meta_classifier=None, k=7, Kp=5,
             Hc=1.0, selection_threshold=0.5, mode='selection', DFP=False,
             with_IH=False, safe_k=None, IH_rate=0.30, random_state=None,
             knn_classifier='knn', knne=False, knn_metric='minkowski',
             DSEL_perc=0.5, n_jobs=-1, voting='hard'):
    """Initialize the METADES classifier.
    
    Parameters
    ----------
    pool_classifiers : list, default=None
        List of base classifiers.
    meta_classifier : classifier, default=None
        Meta-classifier instance.
    k : int, default=7
        Number of neighbors.
    Kp : int, default=5
        Number of output profiles.
    Hc : float, default=1.0
        Hardness threshold.
    selection_threshold : float, default=0.5
        Selection threshold.
    mode : str, default='selection'
        Selection mode.
    DFP : bool, default=False
        Whether to use Dynamic Frienemy Pruning.
    with_IH : bool, default=False
        Whether to use Instance Hardness.
    safe_k : int, default=None
        Safe k value for IH.
    IH_rate : float, default=0.30
        Instance Hardness rate.
    random_state : int, default=None
        Random state for reproducibility.
    knn_classifier : str, default='knn'
        KNN classifier type.
    knne : bool, default=False
        Whether to use KNNE.
    knn_metric : str, default='minkowski'
        Distance metric for KNN.
    DSEL_perc : float, default=0.5
        Percentage of data for DSEL.
    n_jobs : int, default=-1
        Number of parallel jobs.
    voting : str, default='hard'
        Voting method.
    """

def fit(self, X, y):
    """Train the META-DES classifier.
    
    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        The input data.
    y : array of shape (n_samples)
        Class labels of each example in X.
    
    Returns
    -------
    self
    """

def _fit_OP(self, X_op, y_op):
    """Fit the output profiles.
    
    Parameters
    ----------
    X_op : array of shape (n_op_samples, n_features)
        Output profiles features.
    y_op : array of shape (n_op_samples)
        Output profiles labels.
    """

def _sample_selection_agreement(self):
    """Sample selection based on agreement.
    
    Returns
    -------
    selected_samples : array
        Indices of selected samples.
    """

def compute_meta_features(self, scores, idx_neighbors, idx_neighbors_op):
    """Compute meta-features.
    
    Parameters
    ----------
    scores : array
        Competence scores.
    idx_neighbors : array
        Indices of neighbors.
    idx_neighbors_op : array
        Indices of output profile neighbors.
    
    Returns
    -------
    meta_features : array
        Computed meta-features.
    """

def _generate_meta_training_set(self):
    """Generate meta-training set.
    
    Returns
    -------
    X_meta : array
        Meta-features.
    y_meta : array
        Meta-labels.
    """

def _fit_meta_classifier(self, X_meta, y_meta):
    """Fit the meta-classifier.
    
    Parameters
    ----------
    X_meta : array
        Meta-features.
    y_meta : array
        Meta-labels.
    """

def _get_similar_out_profiles(self, probabilities, kp=None):
    """Get similar output profiles.
    
    Parameters
    ----------
    probabilities : array of shape (n_samples, n_classifiers, n_classes)
        Probability estimates.
    kp : int
        Number of profiles.
    
    Returns
    -------
    dists : array
        Distances to profiles.
    idx : array
        Indices of profiles.
    """

def select(self, competences):
    """Select classifiers using meta-learning.
    
    Parameters
    ----------
    competences : array of shape (n_samples, n_classifiers)
        Competence estimates.
    
    Returns
    -------
    selected_classifiers : array of shape (n_samples, n_classifiers)
        Boolean mask indicating selected classifiers.
    """

def estimate_competence_from_proba(self, neighbors, probabilities, distances=None):
    """Estimate competence from probabilities.
    
    Parameters
    ----------
    neighbors : array of shape (n_samples, n_neighbors)
        Indices of neighbors.
    probabilities : array of shape (n_samples, n_classifiers, n_classes)
        Probability estimates.
    distances : array of shape (n_samples, n_neighbors)
        Distances to neighbors.
    
    Returns
    -------
    competences : array of shape (n_samples, n_classifiers)
        Competence estimates.
    """
```

**Parameter Description**:
- `pool_classifiers` (list): List of base classifiers, default is None
- `meta_classifier`: Meta-classifier instance
- `k` (int): Number of neighbors, default is 7
- `Kp` (int): Number of output profiles, default is 5
- `Hc` (float): Hardness threshold, default is 1.0
- `selection_threshold` (float): Selection threshold, default is 0.5
- `mode` (str): Selection mode, default is 'selection'
- `DFP` (bool): Whether to use Dynamic Frienemy Pruning, default is False
- `with_IH` (bool): Whether to use Instance Hardness, default is False
- `safe_k` (int): Safe k value for IH, default is None
- `IH_rate` (float): Instance Hardness rate, default is 0.30
- `random_state` (int): Random state for reproducibility, default is None
- `knn_classifier` (str): KNN classifier type, default is 'knn'
- `knne` (bool): Whether to use KNNE, default is False
- `knn_metric` (str): Distance metric for KNN, default is 'minkowski'
- `DSEL_perc` (float): Percentage of data for DSEL, default is 0.5
- `n_jobs` (int): Number of parallel jobs, default is -1
- `voting` (str): Voting method, default is 'hard'

#### 41. KNOP Class - K-Nearest Output Profiles

**Import Statement**:
```python
from deslib.des.knop import KNOP
```

**Function**: K-Nearest Output Profiles dynamic ensemble selection method that uses output profiles for classifier selection.

**Class Definition**:
```python
class KNOP(BaseDES):
    """k-Nearest Output Profiles (KNOP).

    This method selects all classifiers that correctly classified at least
    one sample belonging to the region of competence of the query sample.
    In this case, the region of competence is estimated using the decisions
    of the base classifier (output profiles). Thus, the similarity between
    the query and the validation samples are measured in the decision space
    rather than the feature space. Each selected classifier has a number of
    votes equals to the number of samples in the region of competence that
    it predicts the correct label. The votes obtained by all
    base classifiers are aggregated to obtain the final ensemble decision.

    Parameters
    ----------
     pool_classifiers : list of classifiers (Default = None)
        The generated_pool of classifiers trained for the corresponding
        classification problem. Each base classifiers should support the method
        "predict". If None, then the pool of classifiers is a bagging
        classifier.

    k : int (Default = 7)
        Number of neighbors used to estimate the competence of the base
        classifiers.

    DFP : Boolean (Default = False)
        Determines if the dynamic frienemy pruning is applied.

    with_IH : Boolean (Default = False)
        Whether the hardness level of the region of competence is used to
        decide between using the DS algorithm or the KNN for classification of
        a given query sample.

    safe_k : int (default = None)
        The size of the indecision region.

    IH_rate : float (default = 0.3)
        Hardness threshold. If the hardness level of the competence region is
        lower than the IH_rate the KNN classifier is used. Otherwise, the DS
        algorithm is used for classification.

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    knn_classifier : {'knn', 'faiss', None} (Default = 'knn')
         The algorithm used to estimate the region of competence:

         - 'knn' will use :class:`KNeighborsClassifier` from sklearn
          :class:`KNNE` available on `deslib.utils.knne`

         - 'faiss' will use Facebook's Faiss similarity search through the
           class :class:`FaissKNNClassifier`

         - None, will use sklearn :class:`KNeighborsClassifier`.

    knne : bool (Default=False)
        Whether to use K-Nearest Neighbor Equality (KNNE) for the region
        of competence estimation.

    DSEL_perc : float (Default = 0.5)
        Percentage of the input data used to fit DSEL.
        Note: This parameter is only used if the pool of classifier is None or
        unfitted.

    voting : {'hard', 'soft'}, default='hard'
            If 'hard', uses predicted class labels for majority rule voting.
            Else if 'soft', predicts the class label based on the argmax of
            the sums of the predicted probabilities, which is recommended for
            an ensemble of well-calibrated classifiers.

    n_jobs : int, default=-1
        The number of parallel jobs to run. None means 1 unless in
        a joblib.parallel_backend context. -1 means using all processors.
        Doesn’t affect fit method.

    References
    ----------
    Cavalin, Paulo R., Robert Sabourin, and Ching Y. Suen.
    "LoGID: An adaptive framework combining local and global
    incremental learning for dynamic selection of ensembles of HMMs."
    Pattern Recognition 45.9 (2012): 3544-3556.

    Cavalin, Paulo R., Robert Sabourin, and Ching Y. Suen.
    "Dynamic selection approaches for multiple classifier
    systems." Neural Computing and Applications 22.3-4 (2013): 673-688.

    Ko, Albert HR, Robert Sabourin, and Alceu Souza Britto Jr.
    "From dynamic classifier selection to dynamic ensemble
    selection." Pattern Recognition 41.5 (2008): 1718-1731.

    Britto, Alceu S., Robert Sabourin, and Luiz ES Oliveira. "Dynamic selection
    of classifiers—a comprehensive review."
    Pattern Recognition 47.11 (2014): 3665-3680

    R. M. O. Cruz, R. Sabourin, and G. D. Cavalcanti, “Dynamic classifier
    selection: Recent advances and perspectives,”
    Information Fusion, vol. 41, pp. 195 – 216, 2018.
    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=7, DFP=False, with_IH=False,
             safe_k=None, IH_rate=0.30, random_state=None,
             knn_classifier='knn', knne=False, DSEL_perc=0.5, n_jobs=-1,
             voting='hard'):
    """Initialize the KNOP classifier."""

def fit(self, X, y):
   """Train the DS model by setting the KNN algorithm and
    pre-process the information required to apply the DS
    methods. In this case, the scores of the base classifiers for
    the dynamic selection dataset (DSEL) are pre-calculated to
    transform each sample in DSEL into an output profile.

    Parameters
    ----------
    X : array of shape (n_samples, n_features)
        Data used to fit the model.

    y : array of shape (n_samples)
        class labels of each example in X.

    Returns
    -------
    self
    """

def _fit_OP(self, X_op, y_op, k):
    """ Fit the set of output profiles.

    Parameters
    ----------
    X_op : array of shape (n_samples, n_features)
        Output profiles of the training data. n_features is equals
        to (n_classifiers x n_classes).

    y_op : array of shape (n_samples)
            Class labels of each sample in X_op.

    k : int
        Number of output profiles used in the region of competence
        estimation.

    """

def _get_similar_out_profiles(self, probabilities):
    """Get the most similar output profiles of the query sample.

    Parameters
    ----------
    probabilities : array of shape (n_samples, n_classifiers, n_classes)
                    predictions of each base classifier for all samples.

    Returns
    -------
    dists : list of shape = [n_samples, k]
            The distances between the query and each sample in the region
            of competence. The vector is ordered in an ascending fashion.

    idx : list of shape = [n_samples, k]
        Indices of the instances belonging to the region of competence of
        the given query sample.
    """

def estimate_competence_from_proba(self, probabilities, neighbors=None, distances=None):
    """The competence of the base classifiers is simply estimated as
    the number of samples in the region of competence that it correctly
    classified. This method received an array with
    the pre-calculated probability  estimates for each query.

    This information is later used to determine the number of votes
    obtained for each base classifier.

    Parameters
    ----------
    neighbors : array of shape (n_samples, n_neighbors)
        Indices of the k nearest neighbors.

    distances : array of shape (n_samples, n_neighbors)
                    Distances from the k nearest neighbors to the query.

    probabilities : array of shape (n_samples, n_classifiers, n_classes)
        Probabilities estimates obtained by each each base classifier
        for each query sample.

    Returns
    -------
    competences : array of shape (n_samples, n_classifiers)
        Competence level estimated for each base classifier and test
        example.
    """

def select(self, competences):
     """Select the base classifiers for the classification of the query
    sample.

    Each base classifier can be selected more than once. The number of
    times a base classifier is selected (votes) is equals to the number
    of samples it correctly classified in the region of competence.

    Parameters
    ----------
    competences : array of shape (n_samples, n_classifiers)
        Competence level estimated for each base classifier and test
        example.

    Returns
    -------
    selected_classifiers : array of shape (n_samples, n_classifiers)
        Boolean matrix containing True if the base classifier is selected,
        False otherwise.
    """
```

**Parameter Description**:
- `pool_classifiers` (list): List of base classifiers, default is None
- `k` (int): Number of neighbors, default is 7
- `DFP` (bool): Whether to use Dynamic Frienemy Pruning, default is False
- `with_IH` (bool): Whether to use Instance Hardness, default is False
- `safe_k` (int): Safe k value for IH, default is None
- `IH_rate` (float): Instance Hardness rate, default is 0.30
- `random_state` (int): Random state for reproducibility, default is None
- `knn_classifier` (str): KNN classifier type, default is 'knn'
- `knne` (bool): Whether to use KNNE, default is False
- `DSEL_perc` (float): Percentage of data for DSEL, default is 0.5
- `n_jobs` (int): Number of parallel jobs, default is -1
- `voting` (str): Voting method ('hard', 'soft'), default is 'hard'

#### 42. DESMI Class - Dynamic Ensemble Selection Mutual Information

**Import Statement**:
```python
from deslib.des.des_mi import DESMI
```

**Function**: Dynamic Ensemble Selection using Mutual Information that selects classifiers based on mutual information criteria.

**Class Definition**:
```python
class DESMI(BaseDS):
    """Dynamic ensemble Selection for multi-class imbalanced datasets (DES-MI).

    Parameters
    ----------
     pool_classifiers : list of classifiers (Default = None)
        The generated_pool of classifiers trained for the corresponding
        classification problem. Each base classifiers should support the method
        "predict". If None, then the pool of classifiers is a bagging
        classifier.

    k : int (Default = 7)
        Number of neighbors used to estimate the competence of the base
        classifiers.

    DFP : Boolean (Default = False)
        Determines if the dynamic frienemy pruning is applied.

    with_IH : Boolean (Default = False)
        Whether the hardness level of the region of competence is used to
        decide between using the DS algorithm or the KNN for classification of
        a given query sample.

    safe_k : int (default = None)
        The size of the indecision region.

    IH_rate : float (default = 0.3)
        Hardness threshold. If the hardness level of the competence region is
        lower than the IH_rate the KNN classifier is used. Otherwise, the DS
        algorithm is used for classification.

    alpha : float (Default = 0.9)
            Scaling coefficient to regulate the weight value

    random_state : int, RandomState instance or None, optional (default=None)
        If int, random_state is the seed used by the random number generator;
        If RandomState instance, random_state is the random number generator;
        If None, the random number generator is the RandomState instance used
        by `np.random`.

    knn_classifier : {'knn', 'faiss', None} (Default = 'knn')
         The algorithm used to estimate the region of competence:

         - 'knn' will use :class:`KNeighborsClassifier` from sklearn
          :class:`KNNE` available on `deslib.utils.knne`

         - 'faiss' will use Facebook's Faiss similarity search through the
           class :class:`FaissKNNClassifier`

         - None, will use sklearn :class:`KNeighborsClassifier`.

    knn_metric : {'minkowski', 'cosine', 'mahalanobis'} (Default = 'minkowski')
        The metric used by the k-NN classifier to estimate distances.

        - 'minkowski' will use minkowski distance.

        - 'cosine' will use the cosine distance.

        - 'mahalanobis' will use the mahalonibis distance.

    knne : bool (Default=False)
        Whether to use K-Nearest Neighbor Equality (KNNE) for the region
        of competence estimation.

    DSEL_perc : float (Default = 0.5)
        Percentage of the input data used to fit DSEL.
        Note: This parameter is only used if the pool of classifier is None or
        unfitted.

    voting : {'hard', 'soft'}, default='hard'
            If 'hard', uses predicted class labels for majority rule voting.
            Else if 'soft', predicts the class label based on the argmax of
            the sums of the predicted probabilities, which is recommended for
            an ensemble of well-calibrated classifiers.

    n_jobs : int, default=-1
        The number of parallel jobs to run. None means 1 unless in
        a joblib.parallel_backend context. -1 means using all processors.
        Doesn’t affect fit method.

    References
    ----------
    García, S.; Zhang, Z.-L.; Altalhi, A.; Alshomrani, S. & Herrera, F.
    "Dynamic ensemble selection for multi-class
    imbalanced datasets." Information Sciences, 2018, 445-446, 22 - 37

    Britto, Alceu S., Robert Sabourin, and Luiz ES Oliveira. "Dynamic selection
    of classifiers—a comprehensive review."
    Pattern Recognition 47.11 (2014): 3665-3680

    R. M. O. Cruz, R. Sabourin, and G. D. Cavalcanti, “Dynamic classifier
    selection: Recent advances and perspectives,”
    Information Fusion, vol. 41, pp. 195 – 216, 2018.
    """
```

**Core Methods**:
```python
def __init__(self, pool_classifiers=None, k=7, pct_accuracy=0.5, alpha=0.9,
             DFP=False, with_IH=False, safe_k=None, IH_rate=0.30,
             random_state=None, knn_classifier='knn', knn_metric='minkowski',
             knne=False, DSEL_perc=0.5, n_jobs=-1, voting='hard'):
    """Initialize the DESMI classifier.
    
    Parameters
    ----------
    pool_classifiers : list, default=None
        List of base classifiers.
    k : int, default=7
        Number of neighbors.
    pct_accuracy : float, default=0.5
        Accuracy threshold percentage.
    alpha : float, default=0.9
        Alpha parameter for MI calculation.
    DFP : bool, default=False
        Whether to use Dynamic Frienemy Pruning.
    with_IH : bool, default=False
        Whether to use Instance Hardness.
    safe_k : int, default=None
        Safe k value for IH.
    IH_rate : float, default=0.30
        Instance Hardness rate.
    random_state : int, default=None
        Random state for reproducibility.
    knn_classifier : str, default='knn'
        KNN classifier type.
    knn_metric : str, default='minkowski'
        Distance metric for KNN.
    knne : bool, default=False
        Whether to use KNNE.
    DSEL_perc : float, default=0.5
        Percentage of data for DSEL.
    n_jobs : int, default=-1
        Number of parallel jobs.
    voting : str, default='hard'
        Voting method ('hard', 'soft').
    """

def estimate_competence(self, competence_region, distances=None,
                            predictions=None):
     """estimate the competence level of each base classifier :math:`c_{i}`
    for the classification of the query sample. Returns a ndarray
    containing the competence level of each base classifier.

    The competence is estimated using the accuracy criteria.
    The accuracy is estimated by the weighted results of classifiers who
    correctly classify the members in the competence region. The weight
    of member :math:`x_i` is related to the number of samples of the same
    class of :math:`x_i` in the training dataset.
    For detail, please see the first reference, Algorithm 2.

    Parameters
    ----------
    competence_region : array of shape (n_samples, n_neighbors)
        Indices of the k nearest neighbors according for each test sample.

    distances : array of shape (n_samples, n_neighbors)
        Distances from the k nearest neighbors to the query.

    predictions : array of shape (n_samples, n_classifiers)
        Predictions of the base classifiers for all test examples.

    Returns
    -------
    accuracy : array of shape = [n_samples, n_classifiers}
        Local Accuracy estimates (competences) of the base classifiers
        for all query samples.

    """

def select(self, competences):
    """Select classifiers based on MI criteria.

    Parameters
    ----------
    competences : array of shape (n_samples, n_classifiers)
        Competence estimates for each classifier.

    Returns
    -------
    selected_classifiers : array of shape (n_samples, n_classifiers)
        Boolean mask indicating selected classifiers.
    """

def classify_with_ds(self, predictions, probabilities=None,
                         neighbors=None, distances=None, DFP_mask=None):
    """Predicts the label of the corresponding query sample.

    Parameters
    ----------
    predictions : array of shape (n_samples, n_classifiers)
        Predictions of the base classifiers for all test examples.

    probabilities : array of shape (n_samples, n_classifiers, n_classes)
        Probabilities estimates of each base classifier for all test
        examples.

    neighbors : array of shape (n_samples, n_neighbors)
        Indices of the k nearest neighbors according for each test sample.

    distances : array of shape (n_samples, n_neighbors)
                    Distances from the k nearest neighbors to the query

    DFP_mask : array of shape (n_samples, n_classifiers)
        Mask containing 1 for the selected base classifier and 0 otherwise.

    Notes
    ------
    Different than other DES techniques, this method only select N
    candidates from the pool of classifiers.

    Returns
    -------
    predicted_label : array of shape (n_samples)
                        Predicted class label for each test example.
    """

def predict_proba_with_ds(self, predictions, competence_region=None, distances=None, DFP_mask=None):
    """Predict probabilities using DES-MI.

    Parameters
    ----------
    predictions : array of shape (n_samples, n_classifiers)
        Predictions from base classifiers.
    probabilities : array of shape (n_samples, n_classifiers, n_classes)
        Probability estimates from base classifiers.
    competence_region : array of shape (n_samples, n_neighbors)
        Indices of samples in competence region.
    distances : array of shape (n_samples, n_neighbors)
        Distances to nearest neighbors.
    DFP_mask : array of shape (n_samples, n_classifiers)
        Dynamic frienemy pruning mask.

    Returns
    -------
    predicted_proba : array of shape (n_samples, n_classes)
        Predicted probabilities.
    """

def _validate_parameters(self):
    """Check if the parameters passed as argument are correct.

    Raises
    ------
    ValueError
        If the hyper-parameters are incorrect.
    """
```

**Parameter Description**:
- `pool_classifiers` (list): List of base classifiers, default is None
- `k` (int): Number of neighbors, default is 7
- `pct_accuracy` (float): Accuracy threshold percentage, default is 0.4
- `alpha` (float): Alpha parameter for MI calculation, default is 0.9
- `DFP` (bool): Whether to use Dynamic Frienemy Pruning, default is False
- `with_IH` (bool): Whether to use Instance Hardness, default is False
- `safe_k` (int): Safe k value for IH, default is None
- `IH_rate` (float): Instance Hardness rate, default is 0.30
- `random_state` (int): Random state for reproducibility, default is None
- `knn_classifier` (str): KNN classifier type, default is 'knn'
- `knn_metric` (str): Distance metric for KNN, default is 'minkowski'
- `knne` (bool): Whether to use KNNE, default is False
- `DSEL_perc` (float): Percentage of data for DSEL, default is 0.5
- `n_jobs` (int): Number of parallel jobs, default is -1
- `voting` (str): Voting method ('hard', 'soft'), default is 'hard'
- `pct_accuracy` (float): Accuracy threshold percentage, default is 0.5
- `alpha` (float): Alpha parameter for MI calculation, default is 0.9

### Actual Usage Modes

#### Basic Usage

```python
from sklearn.ensemble import RandomForestClassifier
from deslib.des.knora_e import KNORAE

# Create a classifier pool
pool_classifiers = [RandomForestClassifier(n_estimators=10) for _ in range(5)]
for clf in pool_classifiers:
    clf.fit(X_train, y_train)

# Basic usage
knorae = KNORAE(pool_classifiers, k=7)
knorae.fit(X_dsel, y_dsel)
y_pred = knorae.predict(X_test)
```

#### Oracle Usage Example

```python
from deslib.static.oracle import Oracle

# Oracle needs true labels for prediction
oracle = Oracle(pool_classifiers)
oracle.fit(X_dsel, y_dsel)
y_pred = oracle.predict(X_test, y_test)  # Note: True labels need to be passed in
```

#### Configured Usage

```python
from deslib.des.knora_e import KNORAE
from deslib.dcs.ola import OLA

# Custom configuration
knorae_config = KNORAE(
    pool_classifiers, 
    k=7, 
    DFP=True, 
    knn_classifier='faiss',
    voting='soft'
)

ola_config = OLA(
    pool_classifiers,
    k=5,
    with_IH=True,
    IH_rate=0.25,
    selection_method='diff',
    diff_thresh=0.05
)

# Train and predict using the configuration
knorae_config.fit(X_dsel, y_dsel)
y_pred_knorae = knorae_config.predict(X_test)

ola_config.fit(X_dsel, y_dsel)
y_pred_ola = ola_config.predict(X_test)
```

#### Tool Function Usage Mode

```python
import numpy as np
from deslib.util.aggregation import majority_voting
from deslib.util.diversity import Q_statistic

def ensemble_analysis(classifier_ensemble, X, y_true, y_pred1, y_pred2):
    """Auxiliary function: Analyze the ensemble prediction results"""
    # Aggregate predictions
    agg_result = majority_voting(classifier_ensemble, X)
    
    # Calculate diversity
    div_score = Q_statistic(y_true, y_pred1, y_pred2)
    
    return agg_result, div_score

# Usage example
# Assume there are classifier ensembles and prediction results
classifier_ensemble = [clf1, clf2, clf3]  # List of classifiers
X = np.array([[1, 2], [3, 4], [5, 6]])   # Input data
y_true = np.array([0, 1, 0])             # True labels
y_pred1 = np.array([0, 1, 1])            # Prediction of classifier 1
y_pred2 = np.array([0, 0, 1])            # Prediction of classifier 2

agg_result, div_score = ensemble_analysis(classifier_ensemble, X, y_true, y_pred1, y_pred2)
print(f"Aggregated result: {agg_result}")
print(f"Diversity score: {div_score}")
```

#### FAISS Acceleration Usage Example

```python
from deslib.util.faiss_knn_wrapper import FaissKNNClassifier, is_available

# Use FAISS to accelerate KNN
if is_available():
    faiss_knn = FaissKNNClassifier(n_neighbors=7, algorithm='brute')
    faiss_knn.fit(X_train, y_train)
    distances, indices = faiss_knn.kneighbors(X_test)
    print("FAISS KNN results:", indices)
else:
    print("The faiss library is not installed, so FAISS acceleration cannot be used")
```

### Supported Algorithm Types

- **Dynamic Ensemble Selection (DES)**: KNORAE, KNORAU, METADES, DESP, KNOP, DESKNN
- **Dynamic Classifier Selection (DCS)**: OLA, LCA, MCB, APriori, APosteriori
- **Static Ensemble Methods**: Oracle, SingleBest, StaticSelection, StackedClassifier
- **Tool Functions**: Aggregation functions, diversity metrics, instance hardness analysis, FAISS KNN

### Error Handling

The system provides a complete error handling mechanism:
- **Dependency Check**: Automatically check whether optional dependencies such as FAISS are installed
- **Parameter Validation**: Validate input parameters such as classifier pools and data formats
- **Status Check**: Ensure the correct calling order of fit before predict
- **Exception Capture**: Gracefully handle various runtime errors

### Important Notes

1. **Classifier Pool Requirements**: `pool_classifiers` must be a list of scikit-learn compatible classifiers that have already been fitted.
2. **Data Splitting**: It is recommended to separate the DSEL region from the training set to avoid overfitting.
3. **Special Usage of Oracle**: The `predict` method of Oracle requires both X and y parameters to be passed in because it needs the true labels to determine which classifier is correct.
4. **FAISS Dependency**: The faiss library needs to be installed when using `knn_classifier='faiss'`.
5. **Parallel Acceleration**: Control the parallelism through the `n_jobs` parameter to improve the efficiency of large-scale data processing.
6. **Compatibility**: All algorithms are compatible with the scikit-learn API and can be seamlessly integrated with Pipeline, GridSearchCV, etc.
7. **Tool Function Parameters**: `majority_voting` requires a classifier ensemble and input data to be passed in, and `Q_statistic` requires the true labels and the prediction results of two classifiers to be passed in.

---

