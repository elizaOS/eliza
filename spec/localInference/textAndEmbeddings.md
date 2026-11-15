# Text and embeddings

The local provider answers two kinds of model request: text generation and
embeddings. It answers from the models the device holds
([models](./models.md)), and it never quietly answers with a model the
owner did not choose. Whether a request goes to this provider or to
another at all is the agent's model routing; this spec states what the
local provider does once a request reaches it and who owns embeddings.

## Story: Answer from the model I chose

> As an owner running models on my device, I want each request answered by
> the model I set for it, or refused, and my stored memories searched only
> with embeddings that can be compared with them.

### Text is generated only by the active model once it is ready

While the active model is loading, failed or absent, the local provider
reports that it is not ready; it does not load or use another model.

```quint
import models as M from "./models"
pure def localTextModel(active: str, status: M::ActiveStatus): str =
  if (active != "" and status == M::ActiveReady) active else ""
pure val activeValues = Set("", "model1", "model2")
pure def lawTextNeedsTheReadyActiveModel(active: str, status: M::ActiveStatus): bool =
  localTextModel(active, status) != "" implies (status == M::ActiveReady and localTextModel(active, status) == active)
```

### An embedding is computed only by the model assigned to embeddings

The embedding slot's model answers when it is installed. When the slot is
empty or its model is gone, the request is refused, never answered by
another model.

```quint
pure def localEmbeddingModel(assigned: str, assignedInstalled: bool): str = if (assigned != "" and assignedInstalled) assigned else ""
pure val assignedValues = Set("", "model1", "model2")
pure def lawEmbeddingsComeFromTheAssignedModel(assigned: str, assignedInstalled: bool): bool =
  localEmbeddingModel(assigned, assignedInstalled) == "" or (localEmbeddingModel(assigned, assignedInstalled) == assigned and assignedInstalled)
```

### Vectors are compared only within one vector space

A vector space is the model, dimension count and pooling that produced the
vectors. A stored vector is searched only with a query vector of the same
space; vectors of different spaces are never compared, even when their
lengths agree. The local embedding model declares the same space as the
hosted embedding endpoint it stands in for, so memories embedded by either
remain searchable.

```quint
type Pooling = ClsPooling | MeanPooling | LastTokenPooling
type VectorSpace = { spaceModel: str, dimensions: int, pooling: Pooling }
pure def vectorsComparable(stored: VectorSpace, query: VectorSpace): bool = stored == query
pure val storedValues: Set[VectorSpace] = Set({ spaceModel: "bge-small", dimensions: 384, pooling: ClsPooling }, { spaceModel: "bge-small", dimensions: 384, pooling: MeanPooling }, { spaceModel: "other", dimensions: 384, pooling: ClsPooling })
pure val queryValues = storedValues
pure def lawDifferentSpacesAreNeverCompared(stored: VectorSpace, query: VectorSpace): bool =
  (stored.spaceModel != query.spaceModel or stored.dimensions != query.dimensions or stored.pooling != query.pooling) implies not(vectorsComparable(stored, query))
```

### The operator's embedding endpoint wins, then the hosted service when chosen, then the device

An embedding endpoint the operator configured always serves embeddings.
Otherwise the hosted service serves them when the agent is connected to it
and the owner chose hosted embeddings. Otherwise the local provider owns
embeddings and warms its embedding model.

```quint
type EmbeddingOwner = OperatorEmbeddings | HostedEmbeddings | LocalEmbeddings
pure def embeddingOwner(operatorEndpoint: bool, hostedConnected: bool, hostedChosen: bool): EmbeddingOwner =
  if (operatorEndpoint) OperatorEmbeddings else if (hostedConnected and hostedChosen) HostedEmbeddings else LocalEmbeddings
pure def lawOperatorEndpointIsNeverOverridden(operatorEndpoint: bool, hostedConnected: bool, hostedChosen: bool): bool =
  operatorEndpoint implies embeddingOwner(operatorEndpoint, hostedConnected, hostedChosen) == OperatorEmbeddings
pure def lawDeviceServesEmbeddingsWhenNothingElseIsChosen(hostedConnected: bool): bool =
  embeddingOwner(false, hostedConnected, false) == LocalEmbeddings
```
