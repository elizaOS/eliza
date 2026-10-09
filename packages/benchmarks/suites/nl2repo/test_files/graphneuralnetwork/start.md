# Introduction to the GraphNeuralNetwork Project

GraphNeuralNetwork-master is a Python project that implements various Graph Neural Network (GNN) algorithms. This project mainly implements three classic graph neural network models: GCN (Graph Convolutional Network), GraphSAGE, and GAT (Graph Attention Network), and provides a complete training and testing process on the Cora dataset.

## Natural Language Instruction (Prompt)

Please create a Python project named GraphNeuralNetwork to implement a Graph Neural Network (GNN) algorithm library. The project should include the following features:

1. **Graph Neural Network Model Implementation**: Implement three classic graph neural network algorithms, including GCN (Graph Convolutional Network), GraphSAGE, and GAT (Graph Attention Network). Each model should include a complete network architecture definition, forward propagation logic, and training interface, supporting the configuration of hyperparameters such as custom hidden layer dimensions, activation functions, and dropout rates.

2. **Data Processing Module**: Implement the functions of loading, preprocessing, and standardizing graph data, supporting standard graph datasets such as Cora. It should include core functions such as preprocessing the adjacency matrix, normalizing the feature matrix, and dividing the training/validation/test sets. The data processing should support the sparse matrix format to improve the processing efficiency of large-scale graph data.

3. **Model Training and Evaluation**: Implement a complete training process, including loss function calculation, optimizer configuration, early stopping mechanism, and model checkpoint saving. The evaluation module should support multiple metrics (such as classification accuracy, weighted cross-entropy, etc.) and provide a visualization function for the training process.

4. **Utility Function Library**: Provide utility functions related to graph operations, such as neighbor sampling, graph traversal, and feature aggregation. These functions should support different aggregation strategies (such as mean, sum, max, etc.) and be able to handle directed and undirected graphs.

5. **Interface Design**: Design clear API interfaces for each functional module, supporting simple model creation, training, and prediction calls. Each module should define clear input and output formats and provide detailed documentation.

6. **Testing and Examples**: Provide complete test cases and example code to demonstrate how to use different GNN models for graph node classification tasks. The testing should cover key aspects such as model creation, data loading, the training process, and result evaluation.

7. **Core File Requirements**: The project must include a complete setup.py file, which should not only configure the project as an installable package (supporting `pip install`) but also declare a complete list of dependencies (including core libraries such as tensorflow>=1.12.0, networkx, numpy, scipy, pytest, etc.). The setup.py file can verify whether all functional modules work properly. At the same time, it is necessary to provide gnn/__init__.py as a unified API entry, import the corresponding model classes from the gcn, gat, and graphsage modules, and provide version information, enabling users to access all major functions through a simple `from gnn.** import GCN, GAT, GraphSAGE` statement. In utils.py, there should be a load_data_v1() function to load and preprocess graph data, and a preprocess_adj() function to standardize the adjacency matrix.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.11

### Core Dependency Library Versions

```Plain
absl-py                      2.3.1
astunparse                   1.6.3
certifi                      2025.8.3
charset-normalizer           3.4.2
contourpy                    1.3.2
cycler                       0.12.1
exceptiongroup               1.3.0
flatbuffers                  25.2.10
fonttools                    4.59.0
gast                         0.6.0
google-pasta                 0.2.0
grpcio                       1.74.0
h5py                         3.14.0
idna                         3.10
iniconfig                    2.1.0
joblib                       1.5.1
keras                        3.11.1
kiwisolver                   1.4.8
libclang                     18.1.1
Markdown                     3.8.2
markdown-it-py               3.0.0
MarkupSafe                   3.0.2
matplotlib                   3.10.5
mdurl                        0.1.2
ml_dtypes                    0.5.3
namex                        0.1.0
networkx                     2.8.8
numpy                        2.1.3
opt_einsum                   3.4.0
optree                       0.17.0
packaging                    25.0
pillow                       11.3.0
pip                          23.0.1
pluggy                       1.6.0
protobuf                     5.29.5
Pygments                     2.19.2
pyparsing                    3.2.3
pytest                       8.4.1
python-dateutil              2.9.0.post0
requests                     2.32.4
rich                         14.1.0
scikit-learn                 1.7.1
scipy                        1.15.3
setuptools                   65.5.1
six                          1.17.0
tensorboard                  2.19.0
tensorboard-data-server      0.7.2
tensorflow                   2.19.0
tensorflow-io-gcs-filesystem 0.37.1
termcolor                    3.1.0
threadpoolctl                3.6.0
tomli                        2.2.1
typing_extensions            4.14.1
urllib3                      2.5.0
Werkzeug                     3.1.3
wheel                        0.40.0
wrapt                        1.17.2
```

## Architecture of the GraphNeuralNetwork Project

### Project Directory Structure

```Plain
workspace/
├── .DS_Store
├── .gitattributes
├── .gitignore
├── LICENSE
├── README.md
├── data
│   ├── cora
│   │   ├── README
│   │   ├── cora.cites
│   │   ├── cora.content
│   │   ├── cora.features
│   │   ├── cora_edgelist.txt
│   │   ├── cora_labels.txt
│   │   ├── ind.citeseer.allx
│   │   ├── ind.citeseer.ally
│   │   ├── ind.citeseer.graph
│   │   ├── ind.citeseer.test.index
│   │   ├── ind.citeseer.tx
│   │   ├── ind.citeseer.ty
│   │   ├── ind.citeseer.x
│   │   ├── ind.citeseer.y
│   │   ├── ind.cora.allx
│   │   ├── ind.cora.ally
│   │   ├── ind.cora.graph
│   │   ├── ind.cora.test.index
│   │   ├── ind.cora.tx
│   │   ├── ind.cora.ty
│   │   ├── ind.cora.x
│   │   ├── ind.cora.y
│   │   ├── ind.pubmed.allx
│   │   ├── ind.pubmed.ally
│   │   ├── ind.pubmed.graph
│   │   ├── ind.pubmed.test.index
│   │   ├── ind.pubmed.tx
│   │   ├── ind.pubmed.ty
│   │   ├── ind.pubmed.x
│   │   └── ind.pubmed.y
├── gnn
│   ├── __init__.py
│   ├── best_model.h5
│   ├── gat.py
│   ├── gcn.py
│   ├── graphsage.py
│   ├── run_gat_cora.py
│   ├── run_gcn_cora.py
│   ├── run_graphsage_cora.py
│   ├── utils.py
└── setup.py

```

## API Usage Guide

### Core API

#### 1. Module Import

```python
# Import core models
from gnn.gat import GAT
from gnn.utils import load_data_v1, preprocess_adj
from gnn.gcn import GCN
from gnn.graphsage import sample_neighs, GraphSAGE
```

#### 2. `load_data_v1()` Function - Graph Data Loading

**Function**: Load and preprocess graph datasets, supporting standard graph datasets such as Cora.

**Function Signature**:
```python
def load_data_v1(dataset="cora", path="../data/cora/")
```

**Parameter Description**:
- `dataset` (str): Name of the dataset, default is "cora".
- `path` (str): Path to the data file, default is "../data/cora/".

**Return Value**:
- `adj`: Adjacency matrix (sparse matrix format).
- `features`: Node feature matrix.
- `y_train`: Training set labels.
- `y_val`: Validation set labels.
- `y_test`: Test set labels.
- `train_mask`: Training set mask.
- `val_mask`: Validation set mask.
- `test_mask`: Test set mask.

#### 3. `preprocess_adj()` Function - Adjacency Matrix Preprocessing

**Function**: Perform standardized preprocessing on the adjacency matrix to improve the model training effect.

**Function Signature**:
```python
def preprocess_adj(adj, symmetric=True)
```

**Parameter Description**:
- `adj`: Original adjacency matrix.
- `symmetric` (bool): Whether to construct a symmetric adjacency matrix, default is True.

**Return Value**: Preprocessed adjacency matrix.

#### 4. `GCN()` Function - Graph Convolutional Network Model

**Function**: Create an instance of the GCN model.

**Function Signature**:
```python
def GCN(adj_dim, feature_dim, n_hidden, num_class, num_layers=2, activation=tf.nn.relu, dropout_rate=0.5, l2_reg=0, feature_less=True)
```

**Parameter Description**:
- `adj_dim` (int): Dimension of the adjacency matrix.
- `feature_dim` (int): Dimension of the features.
- `n_hidden` (int): Dimension of the hidden layer.
- `num_class` (int): Number of classification categories.
- `num_layers` (int): Number of network layers, default is 2.
- `activation`: Activation function, default is ReLU.
- `dropout_rate` (float): Dropout rate, default is 0.5.
- `l2_reg` (float): L2 regularization coefficient, default is 0.
- `feature_less` (bool): Whether it is a featureless mode, default is True.

**Return Value**: Compiled GCN model.

#### 5. `GAT()` Function - Graph Attention Network Model

**Function**: Create an instance of the GAT model.

**Function Signature**:
```python
def GAT(adj_dim, feature_dim, num_class, num_layers=2, n_attn_heads=8, att_embedding_size=8, dropout_rate=0.0, l2_reg=0.0, use_bias=True)
```

**Parameter Description**:
- `adj_dim` (int): Dimension of the adjacency matrix.
- `feature_dim` (int): Dimension of the features.
- `num_class` (int): Number of classification categories.
- `num_layers` (int): Number of network layers, default is 2.
- `n_attn_heads` (int): Number of attention heads, default is 8.
- `att_embedding_size` (int): Dimension of the attention embedding, default is 8.
- `dropout_rate` (float): Dropout rate, default is 0.0.
- `l2_reg` (float): L2 regularization coefficient, default is 0.0.
- `use_bias` (bool): Whether to use a bias, default is True.

**Return Value**: Compiled GAT model.

#### 6. `GraphSAGE()` Function - Graph Sampling and Aggregation Model

**Function**: Create an instance of the GraphSAGE model.

**Function Signature**:
```python
def GraphSAGE(feature_dim, neighbor_num, n_hidden, n_classes, use_bias=True, activation=tf.nn.relu, aggregator_type='mean', dropout_rate=0.0, l2_reg=0)
```

**Parameter Description**:
- `feature_dim` (int): Dimension of the features.
- `neighbor_num` (list): Number of neighbor samples per layer.
- `n_hidden` (int): Dimension of the hidden layer.
- `n_classes` (int): Number of classification categories.
- `use_bias` (bool): Whether to use a bias, default is True.
- `activation`: Activation function, default is ReLU.
- `aggregator_type` (str): Aggregation type, default is 'mean'.
- `dropout_rate` (float): Dropout rate, default is 0.0.
- `l2_reg` (float): L2 regularization coefficient, default is 0.

**Return Value**: Compiled GraphSAGE model.

#### 7. `sample_neighs()` Function - Function for neighbor sampling in graph neural networks
**Function**:Function for neighbor sampling in graph neural networks
**Function Signature**:
```python
def sample_neighs(G, nodes, sample_num=None, self_loop=False, shuffle=True):  
    _sample = np.random.choice
    neighs = [list(G[int(node)]) for node in nodes]  
    if sample_num:
        if self_loop:
            sample_num -= 1

        samp_neighs = [
            list(_sample(neigh, sample_num, replace=False)) if len(neigh) >= sample_num else list(
                _sample(neigh, sample_num, replace=True)) for neigh in neighs] 
        if self_loop:
            samp_neighs = [
                samp_neigh + list([nodes[i]]) for i, samp_neigh in enumerate(samp_neighs)]  

        if shuffle:
            samp_neighs = [list(np.random.permutation(x)) for x in samp_neighs]
    else:
        samp_neighs = neighs
    return np.asarray(samp_neighs, dtype=np.float32), np.asarray(list(map(len, samp_neighs)))
```
**Parameter Description**:
- `G`:The graph data structure should be an adjacency table or similar structure that supports G [int (node)] to retrieve the neighbors of a node
- `nodes`:Need to sample the node list of neighbors
- `sample_num=None`:The number of neighbors to be sampled for each node, if None, returns all neighbors
- `self_loop=False`:Does it include a self loop (adding the node itself to the neighbor list)
- `shuffle=True`:Do you randomly shuffle the sampling results
**Return Value**:
Return two numpy arrays:
1.The sampled neighbor list array has a shape of (len (nodes), sample_num) and a data type of float32
2.rray of actual sampled neighbors for each node

### Detailed Description of Configuration Classes

#### 1. `GraphConvolution` Configuration Class

**Function**: Configure the parameter settings of the graph convolution layer.

```python
class GraphConvolution(Layer):
    def __init__(self, units,
                 activation=tf.nn.relu, 
                 dropout_rate=0.5,
                 use_bias=True, 
                 l2_reg=0, 
                 feature_less=False,
                 seed=1024, 
                 **kwargs):
```

**Parameter Description**:
- `units` (int): Output dimension, defining the number of output features of the convolution layer.
- `activation`: Activation function, default is ReLU, controlling the non-linear transformation.
- `dropout_rate` (float): Dropout rate, default is 0.5, preventing overfitting.
- `use_bias` (bool): Whether to use a bias term, default is True.
- `l2_reg` (float): L2 regularization coefficient, default is 0, controlling the weight decay.
- `feature_less` (bool): Whether it is a featureless mode, default is False.
- `seed` (int): Random seed, default is 1024, ensuring reproducibility of the results.

#### 2. GATLayer Class
**Function Description**: Implements the Graph Attention Network (GAT) layer proposed by Veličković et al. This layer computes attention weights between nodes and their neighbors, enabling the model to focus on the most relevant parts of the graph.

##### Initialization Method
```python
__init__(self, 
         att_embedding_size=8, 
         head_num=8, 
         dropout_rate=0.5, 
         l2_reg=0, 
         activation=tf.nn.relu,
         reduction='concat', 
         use_bias=True, 
         seed=1024,
         **kwargs)
```

###### Parameter Description
- `att_embedding_size` (int): Dimension of the attention embedding, default is 8
- `head_num` (int): Number of attention heads, default is 8
- `dropout_rate` (float): Dropout rate, default is 0.5
- `l2_reg` (float): L2 regularization coefficient, default is 0
- `activation` (callable): Activation function, default is tf.nn.relu
- `reduction` (str): Aggregation method for multi-head attention, options are 'concat' or 'mean', default is 'concat'
- `use_bias` (bool): Whether to use bias term, default is True
- `seed` (int): Random seed, default is 1024
- `**kwargs`: Other keyword arguments

##### Method Description

###### `build(self, input_shape)`
Builds layer weights based on the input shape.
- **Parameters**:
  - `input_shape`: A list containing the shapes of input tensors [features_shape, adj_shape]
- **Returns**: None

###### `call(self, inputs, training=None)`
Forward propagation of the layer.
- **Parameters**:
  - `inputs`: A list containing [features, adjacency_matrix]
  - `training`: Boolean indicating whether running in training mode, default is None
- **Returns**:
  - Output tensor with shape `[batch_size, num_nodes, output_dim]`

###### `get_config(self)`
Retrieves the configuration of the layer.
- **Returns**:
  - A dictionary containing the layer configuration

###### `compute_output_shape(self, input_shape)`
Computes the output shape of the layer.
- **Parameters**:
  - `input_shape`: Shape of the input tensor
- **Returns**:
  - Shape of the output tensor

---

##### GATLayer Usage Example
```python
import tensorflow as tf
from gnn.gat import GATLayer

# Initialize GAT layer
gat_layer = GATLayer(
    att_embedding_size=8,  # Attention embedding dimension
    head_num=8,            # Number of attention heads
    dropout_rate=0.0,      # Dropout rate
    l2_reg=0,              # L2 regularization coefficient
    activation=tf.nn.relu  # Activation function
)

# Example input
features = tf.random.normal((32, 100, 64))  # [batch_size, num_nodes, feature_dim]
adj_matrix = tf.random.uniform((32, 100, 100), maxval=2, dtype=tf.int32)  # Binary adjacency matrix

# Forward propagation
output = gat_layer([features, adj_matrix])
```

#### 3. MeanAggregator Class

**Function Description**: Implements the mean aggregator from GraphSAGE proposed by Hamilton et al. This layer aggregates neighbor information by computing the mean of neighbor features, then combines it with the central node's features.

##### Initialization Method
```python
__init__(self, 
         units, 
         input_dim, 
         neigh_max, 
         concat=True, 
         dropout_rate=0.0, 
         activation=tf.nn.relu, 
         l2_reg=0,
         use_bias=False,
         seed=1024,
         **kwargs)
```

###### Parameter Description
- `units` (int): Output dimension, the dimension of aggregated features
- `input_dim` (int): Input feature dimension
- `neigh_max` (int): Maximum number of sampled neighbors
- `concat` (bool): Whether to concatenate central node features with neighbor features, default is True
- `dropout_rate` (float): Dropout rate, default is 0.0
- `activation` (callable): Activation function, default is tf.nn.relu
- `l2_reg` (float): L2 regularization coefficient, default is 0
- `use_bias` (bool): Whether to use bias term, default is False
- `seed` (int): Random seed, default is 1024
- `**kwargs`: Other keyword arguments

##### Method Description

###### `build(self, input_shape)`
Builds layer weights based on the input shape.
- **Parameters**:
  - `input_shape`: A list containing the shapes of input tensors [features_shape, nodes_shape, neighbors_shape]
- **Returns**: None

###### `call(self, inputs, training=None)`
Forward propagation of the layer.
- **Parameters**:
  - `inputs`: A list containing [features, node, neighbours]
  - `training`: Boolean indicating whether running in training mode, default is None
- **Returns**:
  - Output tensor with shape `[batch_size, output_dim]`

###### `get_config(self)`
Retrieves the configuration of the layer.
- **Returns**:
  - A dictionary containing the layer configuration

###### `compute_output_shape(self, input_shape)`
Computes the output shape of the layer.
- **Parameters**:
  - `input_shape`: Shape of the input tensor
- **Returns**:
  - Shape of the output tensor

---

##### MeanAggregator Usage Example
```python
import tensorflow as tf
from gnn.graphsage import MeanAggregator

# Initialize MeanAggregator
agg = MeanAggregator(
    units=128,      # Output dimension
    input_dim=64,   # Input feature dimension
    neigh_max=25,   # Maximum number of neighbors
    concat=True,    # Whether to concatenate central node features
    dropout_rate=0.0 # Dropout rate
)

# Example input
features = tf.random.normal((1000, 64))  # [num_nodes, feature_dim]
nodes = tf.range(32)  # Batch node indices
neighbors = tf.random.uniform((32, 25), maxval=1000, dtype=tf.int32)  # Neighbor indices
neighbor_count = tf.random.uniform((32,), maxval=26, dtype=tf.int32)  # Actual neighbor count

# Forward propagation
output = agg([features, nodes, neighbors, neighbor_count])
```

#### 4. Model Training Configuration Class

**Function**: Configure the hyperparameter settings for model training.

```python
# GCN training configuration
GCN_CONFIG = {
    'num_layers': 2,           # Number of network layers
    'n_hidden': 16,            # Dimension of the hidden layer
    'dropout_rate': 0.5,       # Dropout rate
    'l2_reg': 2.5e-4,         # L2 regularization coefficient
    'learning_rate': 0.01,     # Learning rate
    'epochs': 200,             # Number of training epochs
    'batch_size': None,        # Batch size (full graph training)
    'feature_less': False      # Whether it is a featureless mode
}

# GAT training configuration
GAT_CONFIG = {
    'num_layers': 2,           # Number of network layers
    'n_attn_heads': 8,         # Number of attention heads
    'att_embedding_size': 8,   # Dimension of the attention embedding
    'dropout_rate': 0.0,       # Dropout rate (default, adjust as needed)
    'l2_reg': 0.0,             # L2 regularization coefficient (default, adjust as needed)
    'learning_rate': 0.005,    # Learning rate
    'epochs': 200,             # Number of training epochs
    'use_bias': True           # Whether to use a bias
}

# GraphSAGE training configuration
GRAPHSAGE_CONFIG = {
    'neighbor_num': [10, 25],  # Number of neighbor samples per layer
    'n_hidden': 16,            # Dimension of the hidden layer
    'aggregator_type': 'mean', # Aggregation type: 'mean', 'maxpool', 'meanpool'
    'dropout_rate': 0.0,       # Dropout rate (default)
    'l2_reg': 0,               # L2 regularization coefficient (default)
    'learning_rate': 0.01,     # Learning rate
    'epochs': 200,             # Number of training epochs
    'use_bias': True           # Whether to use a bias
}
```

**Configuration Description**:
- **Network Architecture Configuration**: Control the structural parameters of the model, such as the number of layers, dimensions, and activation functions.
- **Regularization Configuration**: Include the dropout rate and L2 regularization coefficient to prevent overfitting.
- **Training Configuration**: Include training parameters such as the learning rate, number of training epochs, and batch size.
- **Sampling Configuration**: A neighbor sampling configuration specific to GraphSAGE, controlling the inductive learning ability.

### Actual Usage Mode

#### Basic Usage Process

```python
import tensorflow as tf
from gnn.gcn import GCN
from gnn.utils import load_data_v1, preprocess_adj

# 1. Load data
A, features, y_train, y_val, y_test, train_mask, val_mask, test_mask = load_data_v1('cora')

# 2. Preprocess
A = preprocess_adj(A)
features /= features.sum(axis=1, ).reshape(-1, 1)

# 3. Prepare model input
model_input = [features, A]

# 4. Create model
model = GCN(
    adj_dim=A.shape[-1], 
    feature_dim=features.shape[-1], 
    n_hidden=16, 
    num_class=y_train.shape[1], 
    dropout_rate=0.5, 
    l2_reg=0
)

# 5. Compile model
model.compile(
    optimizer=tf.keras.optimizers.Adam(0.01), 
    loss='categorical_crossentropy',
    weighted_metrics=['categorical_crossentropy', 'acc']
)

# 6. Train model
val_data = (model_input, y_val, val_mask)
model.fit(
    model_input, 
    y_train, 
    sample_weight=train_mask, 
    validation_data=val_data,
    batch_size=A.shape[0], 
    epochs=200, 
    shuffle=False, 
    verbose=2
)

# 7. Evaluate model
eval_results = model.evaluate(
    model_input, 
    y_test, 
    sample_weight=test_mask, 
    batch_size=A.shape[0]
)
print('Test accuracy: {}'.format(eval_results[2]))
```

## Detailed Implementation Nodes of Functions

### Node 1: Graph Data Preprocessing and Standardization (Graph Data Preprocessing)

**Function Description**: Implement the functions of loading, preprocessing, and standardizing graph data, supporting standard graph datasets such as Cora. Include core functions such as preprocessing the adjacency matrix, normalizing the feature matrix, and dividing the training/validation/test sets.

**Core Algorithms**:
- Symmetric processing of the adjacency matrix.
- Row normalization of the feature matrix.
- Automatic division of the dataset.
- Optimization of sparse matrices.

**Input and Output Examples**:

```python
from gnn.utils import load_data_v1, preprocess_adj, preprocess_features
import numpy as np

# Data loading
A, features, y_train, y_val, y_test, train_mask, val_mask, test_mask = load_data_v1('cora')

print(f"Original adjacency matrix shape: {A.shape}")
print(f"Original feature matrix shape: {features.shape}")
print(f"Training set size: {np.sum(train_mask)}")
print(f"Validation set size: {np.sum(val_mask)}")
print(f"Test set size: {np.sum(test_mask)}")

# Adjacency matrix preprocessing
A_processed = preprocess_adj(A, symmetric=True)
print(f"Processed adjacency matrix shape: {A_processed.shape}")

# Feature matrix preprocessing
features_processed = preprocess_features(features)
print(f"Processed feature matrix shape: {features_processed.shape}")

# Test verification
assert A_processed.shape == A.shape
assert features_processed.shape == features.shape
assert np.sum(train_mask) + np.sum(val_mask) + np.sum(test_mask) <= features.shape[0]
```

### Node 2: Graph Convolution Layer (Graph Convolution Layer)

**Function Description**: Implement the core layer of the graph convolutional network, supporting feature propagation, weight transformation, activation functions, and non-linear transformations. Based on the message passing mechanism, aggregate neighbor node information.

**Core Algorithms**:
- Graph convolution formula: H(l+1) = σ(D^(-1/2)AD^(-1/2)H(l)W(l)).
- Symmetric normalization.
- Dropout regularization.
- Addition of bias terms.

**Input and Output Examples**:

```python
import tensorflow as tf
from gnn.gcn import GraphConvolution

# Create graph convolution layer
graph_conv = GraphConvolution(
    units=16,
    activation=tf.nn.relu,
    dropout_rate=0.5,
    use_bias=True,
    l2_reg=0
)

# Simulate input data
batch_size = 2708  # Number of nodes in the Cora dataset
feature_dim = 1433  # Cora feature dimension
hidden_dim = 16

# Input features and adjacency matrix
features = tf.random.normal([batch_size, feature_dim])
adj_matrix = tf.random.normal([batch_size, batch_size])

# Forward propagation
output = graph_conv([features, adj_matrix])
print(f"Input feature shape: {features.shape}")
print(f"Adjacency matrix shape: {adj_matrix.shape}")
print(f"Output feature shape: {output.shape}")

# Test verification
assert output.shape == (batch_size, hidden_dim)
assert tf.reduce_all(tf.math.is_finite(output))
```

### Node 3: Graph Attention Mechanism (Graph Attention Mechanism)

**Function Description**: Implement the core attention mechanism of the graph attention network, supporting multi-head attention, attention weight calculation, and neighbor information aggregation. It can adaptively learn the importance weights between nodes.

**Core Algorithms**:
- Attention weight calculation: α_ij = softmax(LeakyReLU(a^T[Wh_i||Wh_j])).
- Multi-head attention aggregation.
- Weighted aggregation of neighbor information.
- Attention dropout.

**Input and Output Examples**:

```python
from gnn.gat import GATLayer

# Create graph attention layer
gat_layer = GATLayer(
    att_embedding_size=8,
    head_num=8,
    dropout_rate=0.0,
    l2_reg=0,
    activation=tf.nn.relu,
    reduction='concat'
)

# Simulate input data
batch_size = 2708
feature_dim = 1433
att_dim = 8

# Input features and adjacency matrix
features = tf.random.normal([batch_size, feature_dim])
adj_matrix = tf.random.normal([batch_size, batch_size])

# Forward propagation
output = gat_layer([features, adj_matrix])
print(f"Input feature shape: {features.shape}")
print(f"Adjacency matrix shape: {adj_matrix.shape}")
print(f"Output feature shape: {output.shape}")

# Test verification
expected_output_dim = att_dim * 8  # 8 attention heads
assert output.shape == (batch_size, expected_output_dim)
assert tf.reduce_all(tf.math.is_finite(output))
```

### Node 4: Neighbor Sampling and Aggregation (Neighbor Sampling and Aggregation)

**Function Description**: Implement the neighbor sampling and feature aggregation mechanism of GraphSAGE, supporting multiple aggregation strategies such as mean aggregation and max pooling aggregation. Realize the inductive learning ability and support large-scale graph data.

**Core Algorithms**:
- Random sampling of neighbor nodes.
- Mean aggregation: h_v = σ(W·mean({h_u, ∀u ∈ N(v)})).
- Max pooling aggregation.
- Feature concatenation and transformation.

**Input and Output Examples**:

```python
from gnn.graphsage import MeanAggregator, sample_neighs
import networkx as nx

# Create graph structure
G = nx.random_graphs.erdos_renyi_graph(100, 0.1)

# Neighbor sampling
nodes = np.arange(50)
sample_neigh, sample_neigh_len = sample_neighs(G, nodes, sample_num=10, self_loop=False)
print(f"Sampled neighbor shape: {sample_neigh.shape}")
print(f"Neighbor length: {sample_neigh_len}")

# Create aggregator
aggregator = MeanAggregator(
    units=16,
    input_dim=1433,
    neigh_max=10,
    concat=True,
    dropout_rate=0.0,
    activation=tf.nn.relu
)

# Simulate input data
features = tf.random.normal([100, 1433])  # 100 nodes, 1433-dimensional features
node_indices = tf.constant([0, 1, 2, 3, 4])  # Central nodes
neighbor_indices = tf.constant(sample_neigh[:5])  # Neighbor nodes

# Aggregation operation
output = aggregator([features, node_indices, neighbor_indices])
print(f"Input feature shape: {features.shape}")
print(f"Number of central nodes: {len(node_indices)}")
print(f"Neighbor node shape: {neighbor_indices.shape}")
print(f"Aggregated output shape: {output.shape}")

# Test verification
assert output.shape == (5, 16)  # 5 nodes, 16-dimensional output
assert tf.reduce_all(tf.math.is_finite(output))
```

### Node 5: Model Training and Evaluation (Model Training and Evaluation)

**Function Description**: Implement a complete model training process, including loss function calculation, optimizer configuration, early stopping mechanism, model checkpoint saving, and performance evaluation. Support multiple evaluation metrics.

**Core Algorithms**:
- Weighted cross-entropy loss.
- Adam optimizer.
- Early stopping mechanism.
- Model checkpoint.
- Multi-metric evaluation.

**Input and Output Examples**:

```python
import tensorflow as tf
from gnn.gcn import GCN
from gnn.utils import load_data_v1, preprocess_adj

# Load and preprocess data
A, features, y_train, y_val, y_test, train_mask, val_mask, test_mask = load_data_v1('cora')
A = preprocess_adj(A)
features /= features.sum(axis=1, ).reshape(-1, 1)

# Prepare model input
model_input = [features, A]

# Create GCN model
model = GCN(
    adj_dim=A.shape[-1],
    feature_dim=features.shape[-1],
    n_hidden=16,
    num_class=y_train.shape[1],
    dropout_rate=0.5,
    l2_reg=0
)

# Compile model
model.compile(
    optimizer=tf.keras.optimizers.Adam(0.01),
    loss='categorical_crossentropy',
    weighted_metrics=['categorical_crossentropy', 'acc']
)

# Train model
val_data = (model_input, y_val, val_mask)
history = model.fit(
    model_input,
    y_train,
    sample_weight=train_mask,
    validation_data=val_data,
    batch_size=A.shape[0],
    epochs=10,
    shuffle=False,
    verbose=1
)

# Evaluate model
eval_results = model.evaluate(
    model_input,
    y_test,
    sample_weight=test_mask,
    batch_size=A.shape[0]
)

print(f"Test loss: {eval_results[0]:.4f}")
print(f"Test accuracy: {eval_results[2]:.4f}")

# Test verification
assert len(eval_results) == 3  # loss, weighted_loss, accuracy
assert 0 <= eval_results[2] <= 1  # Accuracy is in the range of [0,1]
assert eval_results[0] > 0  # Loss value is greater than 0
```