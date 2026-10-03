## Introduction and Goals of the Cherry Project

Cherry is a lightweight Python library **for text classification** that enables users without machine learning knowledge to quickly train a high-accuracy model within 5 minutes. This tool aims to significantly lower the threshold for text classification tasks, allowing developers to easily get started. Its core functions include: training with self-owned datasets, **performing rapid classification through pre-trained models (such as those for news, emails, reviews, etc.)**, and supporting custom tokenization algorithms for optimization. In short, Cherry is committed to providing an easy-to-use text classification system to help developers quickly classify and identify text content (for example, using the `train()` function to train with self-owned data and the `classify()` function to classify new text).

## Natural Language Instructions (Prompt)

Please create a Python project named `cherry` to implement a lightweight text classification library. The project should include the following functions:

1. **Data Handling and Training**: Be able to load and process the training data provided by the user. The data format can be common text files (such as `.txt`, `.csv`), where each piece of data contains text content and its corresponding classification label. The program needs to automatically build a vocabulary from the data and complete model training.
2. **Text Classification Prediction**: Provide a core classification function (or script) that can perform classification prediction on the input new text. Support loading pre-trained models or models trained by users themselves and return the most likely classification label and its confidence (or probability).
3. **Pre-trained Models and Customization**: The project should have several common pre-trained models built-in (such as those for news classification, email classification, sentiment analysis, etc.), which users can directly load and use. At the same time, it should support users to replace or customize core algorithms, such as tokenization methods (for example, allowing users to access jieba or other tokenizers).
4. **Interface Design**: Design independent command-line interfaces or function interfaces for each core function (such as model training, text prediction). Each interface should have clear input and output definitions. For example, the command-line tool should be able to specify the path of the training data, the path to save the model, or the text to be classified through parameters.
5. **Example and Usage Demo**: Provide example code and demonstration cases to show how to call the `train()` and `classify()` functions for model training and prediction. For example, `train(model='my_data', encoding='utf-8')` should complete the training and save the model, and `classify(model='my_data', text='some new text')` should return the prediction result. Finally, integrate them into a complete classification toolkit and provide a clear usage process.
6. **Core File Requirements**: The project must include a complete `setup.py` file. This file should not only configure the project as an installable package (supporting `pip install`) but also declare a complete list of dependencies (including core libraries such as `scikit-learn`, `numpy`, `pandas`, `joblib`, `matplotlib`, `regex`, `tqdm`). The `setup.py` file can verify whether all functional modules work properly. At the same time, it is necessary to provide `cherry/__init__.py` as a unified API entry, import and export Classify, train, performance, search, display, _load_data_from_local, _load_data_from_remote, _decompress_data, _fetch_remote, get_clf, get_vectorizer, get_vectorizer_and_clf, DATA_DIR, load_data, and the main import and export functions, and provide version information, so that users can access all main functions through simple `from cherry.** import **` or `from cherry import **` statements. In `cherry/trainer.py`, there should be a complete training process management function. In `cherry/classifyer.py`, there should be the core logic for classification prediction, handling text feature extraction and classification prediction through various strategies to ensure the integrity and availability of the system.

## Environment Configuration

### Python Version
The Python version used in the current project is: Python 3.7.9

### Core Dependency Library Versions

```
# Scientific computing and data processing
numpy==1.18.4           # Basic library for numerical computing, providing efficient multi-dimensional array objects
scipy==1.4.1            # Scientific computing library, including functions such as numerical integration, optimization, and signal processing

# Machine learning and model-related
scikit-learn==0.23.1    # Machine learning library, including algorithms such as classification, regression, and clustering
joblib==0.14.1          # Used for efficient serialization and parallel computing of models, a common dependency of scikit-learn
threadpoolctl==2.0.0    # Controls multi-threaded/multi-process libraries, a dependency of scikit-learn

# Visualization
matplotlib==3.2.2       # Data visualization library, supporting the drawing of various charts

# Text processing
regex==2020.5.14        # Enhanced regular expression library, supporting more complex text matching

# Progress bar and performance analysis
tqdm==4.46.0            # Displays a loop progress bar to enhance the user experience
tuna==0.4.5             # Python code performance analysis tool

# Compatibility and metadata
importlib-metadata==1.6.0   # Accesses package metadata, compatible with older versions of Python
zipp==3.1.0                 # Used to handle zip files, a dependency of importlib-metadata
```

## Cherry Project Architecture

### Project Directory Structure

```
workspace/
├── .gitignore
├── .travis.yml
├── LICENSE.txt
├── MANIFEST.in
├── README.md
├── README.rst
├── cherry
│   ├── __init__.py
│   ├── api.py
│   ├── base.py
│   ├── classifyer.py
│   ├── common.py
│   ├── displayer.py
│   ├── exceptions.py
│   ├── performancer.py
│   ├── searcher.py
│   ├── trainer.py
├── imgs
│   ├── MNB.png
│   ├── RandomForest.png
│   ├── SGD.png
│   ├── display.png
│   ├── text.png
├── issue_template.md
├── runtests.py
├── setup.cfg
└── setup.py
    

```


## API Usage Guide

### Core API

#### 1. Module Import

```python
import cherry
from cherry.base import *
from cherry.common import * 
from cherry import classify
from cherry.trainer import Trainer
```

#### 2. train() Function - Training a Classification Model

**Function**: Use the specified dataset to train a new text classification model or load a pre-trained model.

**Function Signature**:

```python
def train(
    model,
    language='English', 
    preprocessing=None, 
    categories=None, 
    encoding='utf-8',
    vectorizer=None, 
    vectorizer_method='Count', 
    clf=None, 
    clf_method='MNB', 
    x_data=None, 
    y_data=None
):
```

**Parameter Description**:

- `model` (str): Model name. You can use built-in models (`'email'`, `'review'`, `'newsgroups'`) or the name of a custom dataset folder.
- `language` (str): Language of the dataset, supporting `'English'` and `'Chinese'`, defaulting to `'English'`.
- `preprocessing` (function): Preprocessing function, which will be called before training each input data, defaulting to `None`.
- `categories` (list): Specify the list of training directories, for example, `['alt.atheism', 'comp.graphics']`, defaulting to `None`.
- `encoding` (str): Encoding of the dataset file, defaulting to `'utf-8'`.
- `vectorizer` (object): Feature extractor object, defaulting to `None`, and `CountVectorizer` will be used.
- `vectorizer_method` (str): Shortcut for the feature extraction method, `'Count'` (default), `'Tfidf'`, `'Hashing'`.
- `clf` (object): Classifier object, defaulting to `None`, and `MultinomialNB` will be used.
- `clf_method` (str): Shortcut for the classifier method, `'MNB'` (default), `'SGD'`, `'RandomForest'`, `'AdaBoost'`.
- `x_data` (numpy array): Directly pass in the training text data, defaulting to `None`.
- `y_data` (numpy array): Directly pass in the corresponding label data, defaulting to `None`.

**Return Value**: None. This function will save the trained classifier (`clf.pkz`) and feature extractor (`ve.pkz`) and other model files in the dataset folder.

#### 3. classify() Function - Performing Text Classification

**Function**: Use the trained model to perform classification prediction on new text.

**Function Signature**:

```python
def classify(model, text):
```

**Parameter Description**:

- `model` (str): Name of the model to be used.
- `text` (str / list): Single text or text list to be classified.

**Return Value**: Returns a `Classify` object, which contains the following methods:

- `get_probability()`: Returns an array containing the predicted probability of each category.
- `get_word_list()`: Returns a list containing the keywords used for classification and their weights.

#### 4. performance() Function - Evaluating Model Performance

**Function**: Use k-fold cross-validation to evaluate the accuracy, precision, recall, and F1-score of the model.

**Function Signature**:

```python
def performance(
    model, 
    language='English', 
    preprocessing=None, 
    categories=None, 
    encoding='utf-8',
    vectorizer=None, 
    vectorizer_method='Count', 
    clf=None, 
    clf_method='MNB', 
    x_data=None, 
    y_data=None, 
    n_splits=10, 
    output='Stdout'
):
```

**Parameter Description**:

- Most parameters are the same as those of the `train()` function.
- `n_splits` (int): Number of folds for k-fold cross-validation, defaulting to `10`.
- `output` (str): Reporting output method, `'Stdout'` (print) or `'Files'` (save as a file).

**Return Value**: Returns a `Performance` object, and you can call `get_score()` to obtain the evaluation result.

#### 5. search() Function - Automatic Hyperparameter Search

**Function**: Use grid search or random search to automatically find the best hyperparameter combination.

**Function Signature**:

```python
def search(
    model, 
    parameters, 
    language='English', 
    preprocessing=None, 
    categories=None, 
    encoding='utf-8',
    vectorizer=None, 
    vectorizer_method='Count', 
    clf=None, 
    clf_method='MNB', 
    x_data=None, 
    y_data=None, 
    method='RandomizedSearchCV', 
    cv=3, 
    n_jobs=-1
):
```

**Parameter Description**:

- `parameters` (dict): Parameter grid dictionary, defining the parameters to be searched and the candidate values.
- `method` (str): Search method, `'RandomizedSearchCV'` or `'GridSearchCV'`.
- `cv` (int): Number of folds for cross-validation, defaulting to `3`.
- `n_jobs` (int): Number of parallel processes, defaulting to `-1` (using all cores).

#### 6. display() Function - Result Visualization

**Function**: Display key information such as the confusion matrix in the performance report in the form of a chart.

**Function Signature**:

```python
def display(
    model, 
    language='English', 
    preprocessing=None, 
    categories=None, 
    encoding='utf-8',
    vectorizer=None, 
    vectorizer_method='Count', 
    clf=None, 
    clf_method='MNB', 
    x_data=None, 
    y_data=None
):
```

**Parameter Description**: The same as the parameters of the `train()` function.
#### 7. Class `Classify`
**Location**: `cherry.classifyer.Classify`

**Function**: 
The `Classify` class is used to predict new text data using a pre-trained model. It loads the cached vectorizer and classifier, processes the input text, and returns the classification result.

**Initialization**:
```python
Classify(model, text=None)
```

**Parameters**:
- `model` (str): Name of the pre-trained model used for classification.
- `text` (str or list, optional): Text to be classified. It can be a single string or a list of strings.

**Methods**:
- `get_word_list()`: Returns a list of words in the input text that appear in the model vocabulary.
- `_load_cache(model)`: Loads the cached vectorizer and classifier for the specified model.
- `_classify(text)`: Internal method to process the input text and prepare for classification.

**Example**:
```python
from cherry.classifyer import Classify

# Initialize with a pre-trained model
classifier = Classify('email_model', text='This is a test email')
# Get the list of words used in classification
word_list = classifier.get_word_list()
```

---

#### 8. Function `load_data`
**Location**: `cherry.base.load_data`

**Function**: 
Loads the dataset for training or evaluation, first checking local data and downloading from a remote source if necessary.

**Function Signature**:
```python
def load_data(model, categories=None, encoding=None)
```

**Parameters**:
- `model` (str): Name of the model/dataset to be loaded.
- `categories` (list, optional): List of categories to be loaded. If None, all categories are loaded.
- `encoding` (str, optional): Encoding method of the text file.

**Return**:
- A dataset object containing the loaded data and target labels.

**Example**:
```python
from cherry.base import load_data

# Load all categories
data = load_data('email')
# Load specific categories
data = load_data('email', categories=['spam', 'ham'])
```

---

#### 9. Function `_load_data_from_local`
**Location**: `cherry.base._load_data_from_local`

**Function**: 
An internal function to load data from local cache files. It first checks the cached data and falls back to loading from the original file if the cache is unavailable.

**Function Signature**:
```python
def _load_data_from_local(model, categories=None, encoding=None)
```

**Parameters**:
- `model` (str): Name of the model/dataset to be loaded.
- `categories` (list, optional): List of categories to be loaded.
- `encoding` (str, optional): Encoding method of the text file.

**Return**:
- A dataset object containing the loaded data.

**Possible Exceptions**:
- `NotSupportError`: If the cache file exists but cannot be loaded.

---

#### 10. Function `_load_data_from_remote`
**Location**: `cherry.base._load_data_from_remote`

**Function**: 
Downloads and loads the dataset from a remote source if there is no local data.

**Function Signature**:
```python
def _load_data_from_remote(model, categories=None, encoding=None)
```

**Parameters**:
- `model` (str): Name of the model/dataset to be loaded.
- `categories` (list, optional): List of categories to be loaded.
- `encoding` (str, optional): Encoding method of the text file.

**Return**:
- A dataset object containing the loaded data.

**Possible Exceptions**:
- `FilesNotFoundError`: If the specified model is not found in the remote source.

---

#### 11. Function `_decompress_data`
**Location**: `cherry.base._decompress_data`

**Function**: 
Decompresses the downloaded data file.

**Function Signature**:
```python
def _decompress_data(filename, data_dir)
```

**Parameters**:
- `filename` (str): Name of the compressed file.
- `data_dir` (str): Directory where the compressed file is located.

---

#### 12. Function `_fetch_remote`
**Location**: `cherry.base._fetch_remote`

**Function**: 
Downloads a file from a remote URL to the local file system.

**Function Signature**:
```python
def _fetch_remote(meta_data, data_dir)
```

**Parameters**:
- `meta_data`: A named tuple containing file metadata (filename, url, checksum, encoding).
- `data_dir` (str): Directory to save the downloaded file.

---

#### 13. Function `_sha256` - Calculate File SHA256 Hash
**Location**: `cherry.base._sha256`

**Function**: Calculate the SHA256 hash of a file at the specified path for integrity verification. This function reads the file in chunks to efficiently handle large files without loading them entirely into memory. It is primarily used internally to verify the integrity of downloaded dataset files by comparing their checksums.

**Function Signature**:
```python
def _sha256(path: str) -> str
```

**Parameters**:
- `path` (str): The file path to calculate the SHA256 hash for. Must be a valid path to an existing file.

**Return**:
- `str`: The hexadecimal string representation of the SHA256 hash digest of the file content.

**Raises**:
- `IOError`: If the file cannot be opened or read.
- `FileNotFoundError`: If the specified file path does not exist.

**Example**:
```python
from cherry.base import _sha256

# Calculate hash of a downloaded dataset file
file_hash = _sha256('/path/to/dataset.tar.gz')
print(f"File hash: {file_hash}")

# Verify file integrity by comparing with expected checksum
expected_hash = "25952d9167b86d96503356d8272860d38d3929a31284bbb83d2737f50d23015e"
if file_hash == expected_hash:
    print("File integrity verified")
else:
    print("File may be corrupted")
```

---

#### 14. Function `get_stop_words` - Retrieve Language-Specific Stop Words
**Location**: `cherry.base.get_stop_words`

**Function**: Returns a set of stop words for the specified language to be used in text preprocessing and feature extraction. Stop words are common words that are typically filtered out during text analysis as they carry little meaningful information. For English, it uses scikit-learn's built-in ENGLISH_STOP_WORDS collection, while other languages use predefined stop word sets from the STOP_WORDS dictionary. Note that the English stop word list has known limitations and may not be suitable for all tasks.

**Function Signature**:
```python
def get_stop_words(language: str = 'English') -> frozenset
```

**Parameters**:
- `language` (str, default='English'): The language for which to retrieve stop words. Currently supports 'English' and other languages defined in the STOP_WORDS dictionary such as 'Chinese'.

**Return**:
- `frozenset`: An immutable set of stop words for the specified language. Each word is represented as a string.

**Raises**:
- `NotSupportError`: If the specified language is not currently supported by Cherry.

**Example**:
```python
from cherry.base import get_stop_words

# Get English stop words (default)
english_stops = get_stop_words()
print(f"English stop words count: {len(english_stops)}")

# Get stop words for specific language
english_stops = get_stop_words('English')
chinese_stops = get_stop_words('Chinese')

# Use in text preprocessing
text_words = ['this', 'is', 'a', 'sample', 'text']
filtered_words = [word for word in text_words if word not in english_stops]
print(f"Filtered words: {filtered_words}")
```

---

#### 15. Function `get_clf`
**Location**: `cherry.base.get_clf`

**Function**: 
Returns a classifier instance according to the specified method.

**Function Signature**:
```python
def get_clf(clf_method)
```

**Parameters**:
- `clf_method` (str): Classifier method to be used. Optional values are:
  - 'MNB': Multinomial Naive Bayes
  - 'SGD': Stochastic Gradient Descent
  - 'RandomForest': Random Forest
  - 'AdaBoost': AdaBoost algorithm

**Return**:
- A scikit-learn classifier instance.

**Example**:
```python
from cherry.base import get_clf

# Get a Multinomial Naive Bayes classifier
clf = get_clf('MNB')
```

---

#### 16. Function `get_vectorizer`
**Location**: `cherry.base.get_vectorizer`

**Function**: 
Returns a text vectorizer instance according to the specified method.

**Function Signature**:
```python
def get_vectorizer(language, vectorizer_method)
```

**Parameters**:
- `language` (str): Text language ('English' or 'Chinese').
- `vectorizer_method` (str): Vectorization method to be used. Optional values are:
  - 'Count': Count Vectorizer
  - 'Tfidf': TF-IDF Vectorizer
  - 'Hashing': Hashing Vectorizer

**Return**:
- A scikit-learn vectorizer instance.

---

#### 17. Function `get_vectorizer_and_clf`
**Location**: `cherry.base.get_vectorizer_and_clf`

**Function**: 
A convenient function that returns both the vectorizer and the classifier according to the specified parameters.

**Function Signature**:
```python
def get_vectorizer_and_clf(language, vectorizer, clf, vectorizer_method, clf_method)
```

**Parameters**:
- `language` (str): Text language.
- `vectorizer`: Pre-initialized vectorizer instance (if None, a new instance will be created).
- `clf`: Pre-initialized classifier instance (if None, a new instance will be created).
- `vectorizer_method` (str): If vectorizer is None, use this method to create the vectorizer.
- `clf_method` (str): If clf is None, use this method to create the classifier.

**Return**:
- A tuple containing (vectorizer, classifier).

---

#### 18. Function `write_cache` - Write Compressed Cache Data
**Location**: `cherry.base.write_cache`

**Function**: Writes arbitrary Python objects to compressed cache files within the model directory structure. This function serializes the content using pickle, compresses it with zlib compression, and saves it to the specified path under the model's directory. It's primarily used to cache trained classifiers, vectorizers, and other model components for faster loading in future sessions.

**Function Signature**:
```python
def write_cache(model: str, content: Any, path: str) -> None
```

**Parameters**:
- `model` (str): The name of the model. This determines the subdirectory under DATA_DIR where the cache file will be stored.
- `content` (Any): The Python object to be cached. Can be any pickle-serializable object such as trained models, vectorizers, or processed data.
- `path` (str): The relative file path within the model directory where the cache file will be saved (e.g., 'clf.pkz' or 've.pkz').

**Return**:
- `None`: This function does not return any value.

**Raises**:
- `IOError`: If there are issues creating the directory or writing the file.
- `PickleError`: If the content cannot be serialized.

**Example**:
```python
from cherry.base import write_cache
from sklearn.naive_bayes import MultinomialNB

# Train a classifier
clf = MultinomialNB()
# ... training code ...

# Cache the trained classifier
write_cache('my_model', clf, 'clf.pkz')

# Cache a vectorizer
from sklearn.feature_extraction.text import CountVectorizer
vectorizer = CountVectorizer()
# ... fit vectorizer ...
write_cache('my_model', vectorizer, 've.pkz')
```

---

#### 19. Function `_train_test_split` - Split Cached Data for Training and Testing
**Location**: `cherry.base._train_test_split`

**Function**: Extracts and splits cached dataset into training and testing sets for model evaluation. This internal function processes the cached data structure by extracting data, target labels, and filenames from the 'all' key, then uses scikit-learn's train_test_split to create stratified splits with a fixed random state for reproducible results. The function is designed to work with the specific cache format used by Cherry's data loading system.

**Function Signature**:
```python
def _train_test_split(cache: dict, test_size: float = 0.1) -> tuple
```

**Parameters**:
- `cache` (dict): A dictionary containing cached dataset with an 'all' key that holds a dataset object with 'data', 'target', and 'filenames' attributes.
- `test_size` (float, default=0.1): The proportion of the dataset to include in the test split. Must be between 0.0 and 1.0.

**Return**:
- `tuple`: A 4-element tuple (X_train, X_test, y_train, y_test) where:
  - `X_train` (list): Training data samples
  - `X_test` (list): Testing data samples  
  - `y_train` (numpy.ndarray): Training target labels
  - `y_test` (numpy.ndarray): Testing target labels

**Raises**:
- `KeyError`: If the cache dictionary doesn't contain the expected 'all' key.
- `AttributeError`: If the cached data object doesn't have required attributes.

**Example**:
```python
from cherry.base import _train_test_split, load_data

# Load cached data
cache = {'all': load_data('newsgroups')}

# Split into train/test sets
X_train, X_test, y_train, y_test = _train_test_split(cache, test_size=0.2)

print(f"Training samples: {len(X_train)}")
print(f"Testing samples: {len(X_test)}")
print(f"Training labels shape: {y_train.shape}")
```

---

#### 20. Function `write_file` - Append Data to File
**Location**: `cherry.base.write_file`

**Function**: Appends text data to a file, creating the file if it doesn't exist or adding to existing content. This utility function opens the file in append mode ('a+') which positions the write pointer at the end of the file, ensuring that new data is added without overwriting existing content. It's commonly used for logging, saving results, or accumulating output data during processing.

**Function Signature**:
```python
def write_file(path: str, data: str) -> None
```

**Parameters**:
- `path` (str): The file path where data should be written. Can be relative or absolute path. Parent directories must exist.
- `data` (str): The string data to append to the file. Should include newline characters if line separation is desired.

**Return**:
- `None`: This function does not return any value.

**Raises**:
- `IOError`: If the file cannot be opened for writing due to permissions or other I/O errors.
- `OSError`: If the directory path doesn't exist or there are system-level errors.

**Example**:
```python
from cherry.base import write_file

# Append a single line
write_file('/path/to/output.txt', 'Hello World\n')

# Append multiple lines
write_file('/path/to/log.txt', 'Process started\n')
write_file('/path/to/log.txt', 'Processing complete\n')

# Append results from analysis
results = "Accuracy: 0.95\nPrecision: 0.92\n"
write_file('/path/to/results.txt', results)
```

---

#### 21. Constant `DATA_DIR`
**Location**: `cherry.base.DATA_DIR`

**Description**:
The default directory for storing datasets. It defaults to the 'datasets' folder in the current working directory.

**Example**:
```python
from cherry.base import DATA_DIR
print(f"Data directory: {DATA_DIR}")
```

---

#### 22. Constant `CHERRY_DIR`
**Location**: `cherry.base.CHERRY_DIR`

**Description**:
Path to the Cherry library installation directory, used for locating library resources and configuration files.

**Type**: str

**Example**:
```python
from cherry.base import CHERRY_DIR

print(f"Cherry directory: {CHERRY_DIR}")
```

---

#### 23. Constant `STOP_WORDS`
**Location**: `cherry.common.STOP_WORDS`

**Description**:
Dictionary mapping language names to their corresponding stop word sets. Currently contains Chinese stop words.

**Type**: dict

**Example**:
```python
from cherry.common import STOP_WORDS

# Access Chinese stop words
chinese_stops = STOP_WORDS['Chinese']
```

---

#### 24. Constant `BUILD_IN_MODELS`
**Location**: `cherry.common.BUILD_IN_MODELS`

**Description**:
Dictionary containing metadata for built-in datasets including download URLs, file names, checksums, and encoding information.

**Type**: dict

**Structure**:
Each key is a model name, and each value is a tuple containing:
- filename (str): Name of the compressed data file
- url (str): Download URL for the dataset
- checksum (str): SHA256 hash for file verification
- encoding (str): Text encoding of the dataset

**Example**:
```python
from cherry.common import BUILD_IN_MODELS

# Access model information
newsgroups_info = BUILD_IN_MODELS['newsgroups']
# Returns: ('newsgroups.tar.gz', 'https://...', 'checksum', 'latin1')
```

---

#### 25. Constant `CACHE`
**Location**: `cherry.classifyer.CACHE`

**Description**:
Global cache variable used to store loaded models and vectorizers to avoid repeated loading during classification operations. Initially set to None and populated when first accessed.

**Type**: tuple or None

**Example**:
```python
from cherry.classifyer import CACHE

# CACHE stores (trained_model, vectorizer) tuple when models are loaded
```

---




#### 26. Function `english_tokenizer_wrapper` - English Text Tokenization
**Location**: `cherry.base.english_tokenizer_wrapper`

**Function**: Tokenizes English text into individual words using NLTK's word_tokenize function and filters out single-character tokens. This wrapper function provides a consistent interface for English text tokenization within Cherry's text processing pipeline, automatically handling punctuation separation and filtering out meaningless single characters while preserving meaningful tokens.

**Function Signature**:
```python
def english_tokenizer_wrapper(text: str) -> list
```

**Parameters**:
- `text` (str): The English text string to be tokenized. Can contain sentences, paragraphs, or any text content.

**Return**:
- `list`: A list of string tokens where each token has length greater than 1 character. Punctuation and single characters are filtered out.

**Raises**:
- `ImportError`: If NLTK is not installed or the required tokenizer components are missing.
- `LookupError`: If NLTK data (punkt tokenizer) is not downloaded.

**Example**:
```python
from cherry.base import english_tokenizer_wrapper

# Tokenize a simple sentence
tokens = english_tokenizer_wrapper("This is a sample text.")
print(tokens)  # ['This', 'is', 'sample', 'text']

# Tokenize text with punctuation
tokens = english_tokenizer_wrapper("Hello, world! How are you?")
print(tokens)  # ['Hello', 'world', 'How', 'are', 'you']

# Use in text preprocessing pipeline
text = "Machine learning is powerful."
tokens = english_tokenizer_wrapper(text)
processed_tokens = [token.lower() for token in tokens]
```

---

#### 27. Function `chinese_tokenizer_wrapper` - Chinese Text Tokenization  
**Location**: `cherry.base.chinese_tokenizer_wrapper`

**Function**: Tokenizes Chinese text into meaningful segments using the jieba library and filters out single-character tokens. This wrapper function provides Chinese word segmentation capabilities within Cherry's text processing pipeline. Unlike English text which has natural word boundaries, Chinese text requires sophisticated segmentation algorithms to identify meaningful word units, which jieba handles through dictionary-based and statistical approaches.

**Function Signature**:
```python
def chinese_tokenizer_wrapper(text: str) -> list
```

**Parameters**:
- `text` (str): The Chinese text string to be segmented. Can contain sentences, paragraphs, or any Chinese text content including traditional and simplified characters.

**Return**:
- `list`: A list of Chinese word segments where each segment has length greater than 1 character. Single characters are filtered out to focus on meaningful word units.

**Raises**:
- `ImportError`: If jieba library is not installed.
- `UnicodeDecodeError`: If the text contains unsupported character encodings.

**Example**:
```python
from cherry.base import chinese_tokenizer_wrapper

# Tokenize Chinese sentence
tokens = chinese_tokenizer_wrapper("这是一个示例文本")
print(tokens)  # ['这是', '一个', '示例', '文本'] (actual output may vary)

# Tokenize longer Chinese text
text = "机器学习是人工智能的重要分支"
tokens = chinese_tokenizer_wrapper(text)
print(tokens)  # ['机器学习', '人工智能', '重要', '分支']

# Use in Chinese text preprocessing
chinese_text = "自然语言处理技术发展迅速"
tokens = chinese_tokenizer_wrapper(chinese_text)
filtered_tokens = [token for token in tokens if len(token) >= 2]
```

---

#### 28. `get_tokenizer`

**Function Signature**:
```python
get_tokenizer(language)
```

**Parameters**:
- `language` (str): The language for which to get the tokenizer. Currently supports 'English' and 'Chinese'.

**Returns**:
- A tokenizer function suitable for the specified language.

**Raises**:
- `NotSupportError`: If the specified language is not supported.

**Description**:
Returns an appropriate tokenizer function based on the specified language. Wraps language-specific tokenizers to provide a consistent interface.

---

#### 29. `load_files`

**Function Signature**:
```python
load_files(container_path, categories=None, load_content=True, 
          encoding='utf-8', decode_error='strict', shuffle=True, random_state=0)
```

**Parameters**:
- `container_path` (str): Path to the main folder containing one subfolder per category.
- `categories` (list, optional): List of category names to load. If None, all categories are loaded.
- `load_content` (bool, default=True): Whether to load the actual text data.
- `encoding` (str, default='utf-8'): Encoding of the text files.
- `decode_error` (str, default='strict'): How to handle decoding errors.
- `shuffle` (bool, default=True): Whether to shuffle the data.
- `random_state` (int, RandomState instance or None, default=0): Random seed for shuffling.

**Returns**:
- A `Bunch` object with the following attributes:
  - `data`: List of text contents
  - `target`: Array of integer labels
  - `target_names`: List of category names
  - `filenames`: List of file names

**Description**:
Loads text files with categories as subfolder names. This is a wrapper around scikit-learn's `load_files` function.

---

#### 30. `load_all`


**Function Signature**:
```python
load_all(model, language=None, preprocessing=None, categories=None, 
        encoding=None, vectorizer=None, vectorizer_method=None, 
        clf=None, clf_method=None, x_data=None, y_data=None)
```

**Parameters**:
- `model` (str): Name of the model/dataset to load.
- `language` (str, optional): Language for text processing.
- `preprocessing` (callable, optional): Function to preprocess the text data.
- `categories` (list, optional): List of categories to include.
- `encoding` (str, optional): Encoding of the text files.
- `vectorizer` (object, optional): Custom vectorizer instance.
- `vectorizer_method` (str, optional): Method for vectorization.
- `clf` (object, optional): Custom classifier instance.
- `clf_method` (str, optional): Classification method to use.
- `x_data` (list, optional): Pre-loaded feature data.
- `y_data` (array-like, optional): Pre-loaded target data.

**Returns**:
- `tuple`: (x_data, y_data, vectorizer, clf)
  - `x_data`: List of text data
  - `y_data`: Array of labels
  - `vectorizer`: Configured vectorizer instance
  - `clf`: Configured classifier instance

**Raises**:
- `FilesNotFoundError`: If the specified model data cannot be found.

**Description**:
Main function to load and prepare all necessary components for text classification. Handles data loading, preprocessing, and model initialization.

---

#### 31. `_train`

**Function Signature**:
```python
@classmethod
_train(cls, vectorizer, clf, x_data, y_data)
```

**Parameters**:
- `vectorizer`: Feature extraction/vectorization component.
- `clf`: Classifier component.
- `x_data`: Training data (list of text documents).
- `y_data`: Target values (array of labels).

**Description**:
Internal method that trains a text classification pipeline. Creates and fits a scikit-learn Pipeline with the provided vectorizer and classifier.

---



#### Usage Example

```python
from cherry import Trainer

# Initialize and train a model
trainer = Trainer(
    model='20newsgroups',
    language='English',
    categories=['sci.space', 'comp.graphics'],
    vectorizer_method='tfidf',
    clf_method='sgd'
)

# The model is now trained and cached for future use
```

### Usage Modes

#### Basic Usage

```python
import cherry

# 1. Train a built-in model (only need to execute once)
cherry.train('review')

# 2. Use the trained model for classification
review_text = "This is an extremely entertaining and often insightful collection..."
result = cherry.classify('review', text=review_text)

# 3. Get the prediction result
probability = result.get_probability()
word_list = result.get_word_list()
```

#### Advanced Configuration Usage

```python
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.ensemble import RandomForestClassifier

# Custom vectorizer and classifier
vectorizer = TfidfVectorizer(max_features=5000)
classifier = RandomForestClassifier(n_estimators=100)

# Train the model with custom configuration
cherry.train(
    model='my_model',
    vectorizer=vectorizer,
    clf=classifier,
    encoding='utf-8'
)

# Or use the shortcut
cherry.train(
    model='my_model',
    vectorizer_method='Tfidf',
    clf_method='RandomForest'
)
```

#### In-memory Data Training

```python
# Directly train with data in memory
texts = ["I love this product", "This is terrible", "Great quality"]
labels = ["positive", "negative", "positive"]

cherry.train(
    model='sentiment_model',
    x_data=texts,
    y_data=labels
)

# Use the trained model
result = cherry.classify('sentiment_model', "This is amazing!")
```

#### Performance Evaluation and Optimization

```python
# Evaluate the model performance
perf_result = cherry.performance('my_model', output='Files')
score = perf_result.get_score()

# Visualize the result
cherry.display('my_model')

# Hyperparameter search
parameters = {
    'clf__alpha': [0.1, 0.5, 1.0],
    'clf__fit_prior': [True, False]
}
cherry.search('my_model', parameters)
```

### Supported Data Formats

- **Folder Structure**: Hierarchical relationship of `datasets/model_name/category_name/`
- **Text Encoding**: Multiple encoding formats such as UTF-8, Latin-1, GBK
- **Built-in Datasets**: newsgroups (news classification), review (product review), email (email classification)
- **Custom Data**: Supports any text classification data provided by users.

### Error Handling

The system provides a complete error handling mechanism:

- **File System Errors**: Automatically detect file path and permission issues.
- **Encoding Errors**: Automatically detect and handle different character encodings.
- **Data Format Errors**: Verify the format and integrity of the input data.
- **Model Loading Errors**: Handle issues such as damaged model files or version incompatibilities.

#### Exception Classes

**CherryException**: Base exception class for all Cherry-specific exceptions.
```python
from cherry.exceptions import CherryException
```

**CacheNotFoundError**: Raised when cached files cannot be found or loaded.
```python
from cherry.exceptions import CacheNotFoundError
```

**DownloadError**: Raised when there are issues downloading data from remote sources.
```python
from cherry.exceptions import DownloadError
```

**TokenNotFoundError**: Raised when tokens in the input text do not appear in the training data vocabulary.
```python
from cherry.exceptions import TokenNotFoundError
```

**DataMismatchError**: Raised when there are inconsistencies or mismatches in the input data.
```python
from cherry.exceptions import DataMismatchError
```

**UnicodeFileEncodeError**: Raised when there are Unicode encoding/decoding issues with file operations.
```python
from cherry.exceptions import UnicodeFileEncodeError
```

**MethodNotFoundError**: Raised when a requested method is not found or not implemented.
```python
from cherry.exceptions import MethodNotFoundError
```

**NotSupportError**: Raised when a requested feature is not supported.
```python
from cherry.exceptions import NotSupportError
```

**Example Usage**:
```python
from cherry.exceptions import *

try:
    # Cherry operations that might fail
    cherry.classify('model', text)
except TokenNotFoundError as e:
    print(f"Token not found: {e}")
except CacheNotFoundError as e:
    print(f"Cache error: {e}")
except DownloadError as e:
    print(f"Download failed: {e}")
except CherryException as e:
    print(f"Cherry error: {e}")
```

### Important Notes

1. **Model Files**: After training, model files such as `clf.pkz` and `ve.pkz` will be generated and saved in the corresponding dataset folder.
2. **Chinese Support**: When setting `language='Chinese'`, the jieba tokenizer will be automatically used.
3. **Memory Management**: It is recommended to use `HashingVectorizer` to save memory when training large datasets.
4. **Parallel Processing**: Hyperparameter search supports multi-core parallel processing to improve search efficiency.


## Detailed Implementation Nodes of Functions

### Node 1: Text Classification Training and Prediction

**Function Description**:  
Support multiple classifiers (such as Naive Bayes, Random Forest, SGD, etc.) to train and predict text.

**Main Interfaces**:

- `cherry.trainer.train`
- `cherry.classifyer.Classifyer`
- `cherry.api.train`

**Input and Output Examples**:

```python
from cherry.api import train

# Training data
X = ["I like machine learning", "The weather is nice", "It's raining"]
y = ["positive", "positive", "negative"]

# Train the model
model = train(X, y, model_type="MNB")  # model_type supports "MNB", "RandomForest", "SGD", etc.

```

- **Input**:  
  - X: List[str], text data  
  - y: List[str], labels  
  - model_type: str, model type

- **Output**:  
  - model: Trained model object  
  - result: List[str], predicted labels

---

### Node 2: Text Search

**Function Description**:  
Support keyword search in a text collection and return relevant texts and their scores.

**Main Interfaces**:

- `cherry.searcher.search`
- `cherry.api.search`

**Input and Output Examples**:

```python
from cherry.api import search

corpus = ["I like machine learning", "The weather is nice", "It's raining"]
query = "machine learning"

results = search(corpus, query, top_k=2)
print(results)  # [('I like machine learning', 0.95)]
```

- **Input**:  
  - corpus: List[str], text collection  
  - query: str, query keyword  
  - top_k: int, return the top K results

- **Output**:  
  - results: List[Tuple[str, float]], relevant texts and their scores

---

### Node 3: Category Results Display

**Function Description**:  
Display classification results in the form of charts.

**Main Interfaces**:

- `cherry.displayer.display`
- `cherry.api.display`

**Input and Output Examples**:

```python
from cherry.api import display

labels = ["positive", "negative", "positive"]
display(labels, show_pie=True)  # show_pie: whether to display a pie chart
# Output: Pop up a chart window or save the picture
```

- **Input**:  
  - labels: List[str], classification labels  
  - show_pie: bool, whether to display a pie chart

- **Output**:  
  - Chart display (no return value, directly display or save).

---

### Node 4: Exception Handling

**Function Description**:  
Customize exception classes to handle exceptions such as input/output errors and untrained models.

**Main Interfaces**:

- `cherry.exceptions.*`

**Input and Output Examples**:

```python
from cherry.api import train

try:
    train([], [], model_type="MNB")
except Exception as e:
    print(e)  # Output custom exception information
```

- **Input**:  
  - Erroneous input parameters

- **Output**:  
  - Throw an exception

---
### Node 5: Text Classification

**Function Description**: Classify text and support using pre-trained models for prediction.

**Input and Output Types**:
- Input:
  - `model` (str): Model name
  - `text` (str or List[str]): Text or text list to be classified
- Output: Classification result

**Test Interface and Examples**:
```python
import cherry

# Classify a single text
result = cherry.classify(model='news', text='This is a test text')
print(result)

# Classify multiple texts
results = cherry.classify(model='news', text=['First text', 'Second text'])
print(results)
```
### Node 6: Text Search

**Function Description**:  
Support keyword search in a text collection and return relevant texts and their scores.

**Main Interfaces**:

- `cherry.searcher.search`
- `cherry.api.search`

**Input and Output Examples**:

```python
from cherry.api import search

corpus = ["I like machine learning", "The weather is nice", "It's raining"]
query = "machine learning"

results = search(corpus, query, top_k=2)
print(results)  # [('I like machine learning', 0.95)]
```

- **Input**:  
  - corpus: List[str], text collection  
  - query: str, query keyword  
  - top_k: int, return the top K results

- **Output**:  
  - results: List[Tuple[str, float]], relevant texts and their scores

---