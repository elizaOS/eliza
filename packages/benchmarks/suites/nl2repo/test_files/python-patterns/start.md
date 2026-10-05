## Introduction and Goals of the python-patterns Project

This project collects design patterns and idioms in Python. Its goal is to provide developers with implementation examples of various design patterns, helping them understand the applicable scenarios, advantages and disadvantages of each pattern, as well as how to apply them in actual development.

### Project Goals
1. Provide implementation examples of common design patterns (creational, structural, behavioral, etc.) in the Python language.
2. Help developers understand the implementation details and usage scenarios of each design pattern through rich code examples.
3. Emphasize that when choosing a design pattern, one should focus on "why to choose" rather than just "how to implement".
4. Promote learning, communication, and contributions to design patterns in the Python community.

## Natural Language Instruction (Prompt)

Please create a Python project named python-patterns to implement a design pattern example library. The project should include the following features:

1. Design Pattern Implementation: Collect and implement various common design patterns, including creational, structural, behavioral, etc., covering patterns such as factory, singleton, builder, adapter, decorator, observer, strategy, template method, etc. Each pattern should be accompanied by a brief description and Python code implementation.

2. Code Examples and Annotations: Each design pattern module should include detailed module-level docstrings, explaining the pattern principle, applicable scenarios, advantages and disadvantages, and providing actual application cases in the Python ecosystem as much as possible.

3. Well-Structured Directory: Categorize different types of design patterns into subdirectories such as creational, structural, behavioral, etc., for easy reference and maintenance.

4. Test Cases: Provide independent test cases for the main design pattern implementations to ensure the correctness and reproducibility of each pattern's code and support automated testing.

5. Contribution and Collaboration Guidelines: The project should include contribution guidelines, encouraging community members to supplement new patterns, improve documentation and tests, and put forward unified requirements for code style, documentation format, etc.

6. Core File Requirements: The project must include a complete pyproject.toml file. This file should not only configure the project as an installable package (supporting pip install) but also declare the complete list of dependencies (including core libraries such as black==24.4.2, isort==5.13.2, pylint==3.2.2, etc.). The pyproject.toml file can verify whether all design pattern modules and test cases work properly. At the same time, patterns/__init__.py should be provided as a unified API entry, importing the main classes and functions of various design pattern modules, so that users can access all main functions through a simple "from patterns import Factory, Adapter, Observer ..." statement. Import classes such as Dog, PetShop, patterns, Borg, YourBorg, ComplexHouse, Flat, House, construct_building, Circle, Rectangle, Position, GeometryTools, Data, DecimalViewer, HexViewer, Provider, Publisher, Subscriber, Order, on_sale_discount, ten_percent_discount, Radio, Proxy, client, RealSubject, Subject, BoldWrapper, ItalicWrapper, TextTag, ComputerFacade, Card, CircleShape, DrawingAPI1, DrawingAPI2, CompositeGraphic. The subdirectories such as patterns/creational, patterns/structural, patterns/behavioral, patterns/fundamental, patterns/other store the implementation code of various design patterns. Each pattern is in a separate file, and the file should include detailed docstrings, examples, and reference links, support complete test verification (65 test functions) and code quality checks (black, isort, pylint, mypy), ensuring that the project can be distributed, installed, and used as a standard Python package.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.11

### Core Dependency Library Versions

```Plain
argcomplete       3.6.2
black             25.1.0
build             1.3.0
cachetools        6.1.0
chardet           5.2.0
click             8.2.1
colorama          0.4.6
coverage          7.10.4
distlib           0.4.0
exceptiongroup    1.3.0
filelock          3.19.1
flake8            7.3.0
iniconfig         2.1.0
isort             6.0.1
mccabe            0.7.0
mypy              1.17.1
mypy_extensions   1.1.0
packaging         25.0
pathspec          0.12.1
pip               23.0.1
pipx              1.7.1
platformdirs      4.3.8
pluggy            1.6.0
pycodestyle       2.14.0
pyflakes          3.4.0
Pygments          2.19.2
pyproject-api     1.9.1
pyproject_hooks   1.2.0
pytest            8.4.1
pytest-cov        6.2.1
pytest-randomly   3.16.0
pyupgrade         3.20.0
setuptools        65.5.1
tokenize_rt       6.2.0
tomli             2.2.1
tox               4.28.4
typing_extensions 4.14.1
userpath          1.9.2
virtualenv        20.34.0
wheel             0.40.0
```

## Architecture of the python-patterns Project

### Project Directory Structure

```Plain
workspace/
├── .codespellignore
├── .gitignore
├── .travis.yml
├── Makefile
├── README.md
├── lint.sh
├── patterns
│   ├── __init__.py
│   ├── behavioral
│   │   ├── __init__.py
│   │   ├── catalog.py
│   │   ├── chain_of_responsibility.py
│   │   ├── chaining_method.py
│   │   ├── command.py
│   │   ├── iterator.py
│   │   ├── iterator_alt.py
│   │   ├── mediator.py
│   │   ├── memento.py
│   │   ├── observer.py
│   │   ├── publish_subscribe.py
│   │   ├── registry.py
│   │   ├── servant.py
│   │   ├── specification.py
│   │   ├── state.py
│   │   ├── strategy.py
│   │   ├── template.py
│   │   ├── visitor.py
│   │   ├── viz
│   │   │   ├── catalog.py.png
│   │   │   ├── chain.py.png
│   │   │   ├── chaining_method.py.png
│   │   │   ├── command.py.png
│   │   │   ├── iterator.py.png
│   │   │   ├── mediator.py.png
│   │   │   ├── memento.py.png
│   │   │   ├── observer.py.png
│   │   │   ├── publish_subscribe.py.png
│   │   │   ├── registry.py.png
│   │   │   ├── specification.py.png
│   │   │   ├── state.py.png
│   │   │   ├── strategy.py.png
│   │   │   ├── template.py.png
│   │   │   └── visitor.py.png
│   ├── creational
│   │   ├── __init__.py
│   │   ├── abstract_factory.py
│   │   ├── borg.py
│   │   ├── builder.py
│   │   ├── factory.py
│   │   ├── lazy_evaluation.py
│   │   ├── pool.py
│   │   ├── prototype.py
│   │   ├── viz
│   │   │   ├── abstract_factory.py.png
│   │   │   ├── borg.py.png
│   │   │   ├── builder.py.png
│   │   │   ├── factory_method.py.png
│   │   │   ├── lazy_evaluation.py.png
│   │   │   ├── pool.py.png
│   │   │   └── prototype.py.png
│   ├── dependency_injection.py
│   ├── fundamental
│   │   ├── __init__.py
│   │   ├── delegation_pattern.py
│   │   ├── viz
│   │   │   └── delegation_pattern.py.png
│   ├── other
│   │   ├── __init__.py
│   │   ├── blackboard.py
│   │   ├── graph_search.py
│   │   ├── hsm
│   │   │   ├── __init__.py
│   │   │   ├── classes_hsm.png
│   │   │   ├── classes_test_hsm.png
│   │   │   └── hsm.py
│   ├── structural
│   │   ├── 3-tier.py
│   │   ├── __init__.py
│   │   ├── adapter.py
│   │   ├── bridge.py
│   │   ├── composite.py
│   │   ├── decorator.py
│   │   ├── facade.py
│   │   ├── flyweight.py
│   │   ├── flyweight_with_metaclass.py
│   │   ├── front_controller.py
│   │   ├── mvc.py
│   │   ├── proxy.py
│   │   └── viz
│   │       ├── 3-tier.py.png
│   │       ├── adapter.py.png
│   │       ├── bridge.py.png
│   │       ├── composite.py.png
│   │       ├── decorator.py.png
│   │       ├── facade.py.png
│   │       ├── flyweight.py.png
│   │       ├── front_controller.py.png
│   │       ├── mvc.py.png
│   │       └── proxy.py.png
└── pyproject.toml

```

## API Usage Guide

### Core API

#### 1. Module Import

```
from patterns.creational.abstract_factory import Dog, PetShop
from patterns.creational.borg import Borg, YourBorg
from patterns.creational.builder import ComplexHouse, Flat, House, construct_building
from patterns.creational.lazy_evaluation import Person
from patterns.creational.pool import ObjectPool
from patterns.creational.prototype import Prototype, PrototypeDispatcher
from patterns.structural.adapter import Adapter, Car, Cat, Dog, Human
from patterns.structural.bridge import CircleShape, DrawingAPI1, DrawingAPI2
from patterns.structural.decorator import BoldWrapper, ItalicWrapper, TextTag
from patterns.structural.proxy import Proxy, client
from patterns.behavioral.observer import Data, DecimalViewer, HexViewer
from patterns.behavioral.publish_subscribe import Provider, Publisher, Subscriber
from patterns.behavioral.servant import GeometryTools, Circle, Rectangle, Position
from patterns.behavioral.state import Radio
from patterns.behavioral.strategy import Order, on_sale_discount, ten_percent_discount
from patterns.other.hsm.hsm import (
    Active,
    HierachicalStateMachine,
    Standby,
    Suspect,
    UnsupportedMessageType,
    UnsupportedState,
    UnsupportedTransition,
)
```

#### 2. Abstract Factory Pattern
**Function**: Provide an interface for a set of related or dependent objects without specifying the concrete classes.
**Class Signature**:
```python
class Pet:
    def __init__(self, name: str) -> None
    def speak(self) -> None
    def __str__(self) -> str
```
**Parameter Description**:
- `name` (str): Name of the pet
**Return Value**:
- `speak`/`__str__`: Need to be implemented by subclasses

---

#### 3. Builder Pattern
**Function**: Separate the construction of a complex object from its representation, so that the same construction process can create different representations.
**Class Signature**:
```python
class Building:
    def __init__(self) -> None
    def build_floor(self)
    def build_size(self)
    def __repr__(self) -> str
```
**Parameter Description**: None
**Return Value**:
- `__repr__`: Returns a string describing the building

---

#### 4. Factory Pattern
**Function**: Dynamically create objects according to conditions without specifying the concrete classes.
**Class Signature**:
```python
class Localizer:
    def localize(self, msg: str) -> str
```
**Parameter Description**:
- `msg` (str): String to be localized
**Return Value**: Localized string

---

#### 5. Prototype Pattern
**Function**: Create new objects by cloning prototype instances, reducing the number of classes.
**Class Signature**:
```python
class Prototype:
    def __init__(self, value: str = "default", **attrs: Any) -> None
    def clone(self, **attrs: Any) -> Prototype
```
**Parameter Description**:
- `value` (str): Value of the prototype
- `attrs` (dict): Other attributes
**Return Value**:
- `clone`: Returns a new cloned prototype object


##### 5.1 PrototypeDispatcher
**Function**: Manage prototype instances by registering, retrieving, and unregistering them.

**Class Signature**:
```python
class PrototypeDispatcher:
    def __init__(self) -> None
    def get_objects(self) -> dict[str, Prototype]
    def register_object(self, name: str, obj: Prototype) -> None
    def unregister_object(self, name: str) -> None
```

**Parameter Description**:
- `name` (str): Identifier for the prototype object
- `obj` (Prototype): A prototype instance to register

**Return Value**:
- `get_objects`: Returns a dictionary of all registered prototype objects
- `register_object`: None, stores the object in the dispatcher
- `unregister_object`: None, removes the object from the dispatcher



---

#### 6. Adapter Pattern
**Function**: Convert the interface of a class into another interface expected by the client.
**Class Signature**:
```python
class Adapter:
    def __init__(self, obj, adapted_methods)
```
**Parameter Description**:
- `obj`: Object to be adapted
- `adapted_methods`: Mapping of adapted methods
**Return Value**: Adapter instance

---

#### 7. Bridge Pattern
**Function**: Separate the abstraction from the implementation, allowing both to vary independently.
**Class Signature**:
```python
class DrawingAPI:
    def draw_circle(self, x, y, radius)
class Circle:
    def __init__(self, x, y, radius, drawing_api)
    def draw(self)
    def scale(self, pct)
```
**Parameter Description**: See each method
**Return Value**: None/Operation result

---

#### 8. Composite Pattern
**Function**: Combine objects into a tree structure to represent the "part-whole" hierarchical structure.
**Class Signature**:
```python
class Component:
    def __init__(self, name)
    def add(self, component)
    def remove(self, component)
    def display(self, depth)
```
**Parameter Description**: See each method
**Return Value**: None/Operation result

---

#### 9. Decorator Pattern
**Function**: Dynamically add extra functionality to an object.
**Function Signature**:
```python
def decorate(component: Component) -> Component
```
**Parameter Description**:
- `component` (Component): Object to be decorated
**Return Value**: Enhanced component object

---

#### 10. Facade Pattern
**Function**: Provide a unified high-level interface for a set of interfaces in a subsystem.
**Class Signature**:
```python
class Facade:
    def __init__(self)
    def operation(self)
```
**Parameter Description**: None
**Return Value**: None/Operation result

---

#### 11. Proxy Pattern
**Function**: Provide a proxy for other objects to control access to them.
**Class Signature**:
```python
class Proxy:
    def __init__(self, target)
    def do_the_job(self, user)
```
**Parameter Description**:
- `target`: Object to be proxied
- `user`: User identity
**Return Value**: Operation result

---

#### 12. Chain of Responsibility Pattern
**Function**: Create a chain of receiver objects for a request.
**Class Signature**:
```python
class Handler:
    def __init__(self, successor=None)
    def handle(self, request)
```
**Parameter Description**:
- `successor`: Next handler
- `request`: Request content
**Return Value**: Handling result

---

#### 13. Command Pattern
**Function**: Encapsulate a request as an object, so that other objects can be parameterized with different requests, queues, or logs.
**Class Signature**:
```python
class Command:
    def __init__(self, receiver)
    def execute(self)
```
**Parameter Description**:
- `receiver`: Receiver of the command
**Return Value**: Execution result

---

#### 14. Observer Pattern
**Function**: There is a one-to-many dependency between objects. When the state of the observed object changes, all observers are notified.
**Class Signature**:
```python
class Observer:
    def update(self, message: str) -> None
class Subject:
    def attach(self, observer: Observer) -> None
    def detach(self, observer: Observer) -> None
    def notify(self, message: str) -> None
```
**Parameter Description**: See the detailed API above
**Return Value**: None



---

#### 15. Strategy Pattern
**Function**: Define a series of algorithms, encapsulate them one by one, and make them interchangeable.
**Class Signature**:
```python
class Strategy:
    def do_algorithm(self, data)
```
**Parameter Description**:
- `data`: Input data
**Return Value**: Algorithm result

---

#### 16. Template Method Pattern
**Function**: Define the skeleton of an algorithm in an operation and defer some steps to subclasses.
**Class Signature**:
```python
class AbstractClass:
    def template_method(self)
    def step1(self)
    def step2(self)
```
**Parameter Description**: None
**Return Value**: None/Operation result

---

#### 17. Visitor Pattern
**Function**: Perform operations on elements in a data structure without changing the classes of the elements.
**Class Signature**:
```python
class Visitor:
    def visit(self, element)
class Element:
    def accept(self, visitor)
```
**Parameter Description**:
- `element`/`visitor`: Element to be visited/Visitor
**Return Value**: None/Operation result

---

#### 18. Registry Pattern
**Function**: Record and retrieve all subclasses.
**Class Signature**:
```python
class RegistryHolder(type):
    @classmethod
    def get_registry(cls)
```
**Parameter Description**: None
**Return Value**: Registry dictionary

---

#### 19. Catalog Pattern
**Function**: Select different static methods to execute according to parameters.
**Class Signature**:
```python
class Catalog:
    def __init__(self, param: str)
    def main_method(self)
```
**Parameter Description**:
- `param` (str): Parameter for method selection
**Return Value**: None/Operation result

---

#### 20. Servant Pattern
**Function**: Provide common services for a set of classes.
**Class Signature**:
```python
class Servant:
    def service(self, obj)
```
**Parameter Description**:
- `obj`: Object to be served
**Return Value**: Service result

---

#### 21. Specification Pattern
**Function**: Combine business rules through boolean logic.
**Class Signature**:
```python
class Specification:
    def is_satisfied_by(self, candidate)
```
**Parameter Description**:
- `candidate`: Object to be judged
**Return Value**: Boolean value

---

#### 22. Dependency Injection
**Function**: Decouple components by injecting dependencies.
**Function Signature**:
```python
def inject(dependency, target)
```
**Parameter Description**:
- `dependency`: Dependency object
- `target`: Injection target
**Return Value**: Injection result

---

#### 23. Blackboard Pattern
**Function**: Multiple expert systems collaborate to solve problems.
**Class Signature**:
```python
class AbstractExpert:
    def __init__(self, blackboard)
    @property
    def is_eager_to_contribute(self) -> int
    def contribute(self) -> None
```
**Parameter Description**:
- `blackboard`: Blackboard object
**Return Value**: None/Operation result

#### 24.Publish–Subscribe Pattern
**Function**: Decouple publishers and subscribers by using a central message broker. Publishers send messages to the broker, and subscribers receive only the messages they are interested in.
**Class Signature**:
```python
class Provider:
    def __init__(self) -> None
    def notify(self, msg: str) -> None
    def subscribe(self, msg: str, subscriber: Subscriber) -> None
    def unsubscribe(self, msg: str, subscriber: Subscriber) -> None
    def update(self) -> None

class Publisher:
    def __init__(self, msg_center: Provider) -> None
    def publish(self, msg: str) -> None

class Subscriber:
    def __init__(self, name: str, msg_center: Provider) -> None
    def subscribe(self, msg: str) -> None
    def unsubscribe(self, msg: str) -> None
    def run(self, msg: str) -> None

```
**Parameter Description**:

- `msg` (str): Message content to publish or subscribe.  
- `subscriber` (Subscriber): Subscriber instance interested in a message.  
- `msg_center` (Provider): The central broker that manages subscriptions and message dispatching.  
- `name` (str): Identifier for the subscriber.  

**Return Value**:

- `notify` / `publish`: None, messages are queued in the broker.  
- `update`: Dispatches queued messages to relevant subscribers.  
- `subscribe` / `unsubscribe`: None, modifies subscription list.  
- `run`: Outputs subscriber’s reaction to the received message.  

---

#### 25. Hierarchical State Machine (HSM)

**Function**: Manage the lifecycle of a unit by switching between hierarchical states (Active, Standby, Suspect, Failed) in response to events.

**Class Signatures**:
```python
class HierachicalStateMachine:
    def __init__(self) -> None
    def on_message(self, message_type: str) -> None

class Unit:
    def __init__(self, hsm: HierachicalStateMachine) -> None
    def on_switchover(self) -> None
    def on_fault_trigger(self) -> None
    def on_diagnostics_failed(self) -> None
    def on_diagnostics_passed(self) -> None
    def on_operator_inservice(self) -> None
```

**Parameter Description**:
- `message_type` (str): Type of message received by the state machine (e.g., `"fault trigger"`, `"switchover"`, `"diagnostics passed"`, `"diagnostics failed"`, `"operator inservice"`).
- `hsm` (HierachicalStateMachine): The state machine managing the unit’s states.

**Return Value**:
- `on_message`: Executes the corresponding state transition or raises `UnsupportedMessageType`.
- Unit event methods (`on_switchover`, `on_fault_trigger`, etc.): By default raise `UnsupportedTransition`, meant to be overridden by concrete state classes.

---



## Detailed Implementation Nodes of Functions

#### Node 1: Object Creation and Registration in the Factory Pattern

**Function Description**: Dynamically register and create different types of product objects through the factory class, decoupling object creation from usage. Support flexible expansion of multiple product types.

**Core Algorithm**:
- Register product classes to the factory (key → class).
- Create corresponding product instances according to the key.
- Support passing constructor parameters.

**Input and Output Example**:

```python
from patterns.creational.factory import Factory

class ProductA:
    def operation(self):
        return "ProductA operation"

class ProductB:
    def operation(self):
        return "ProductB operation"

factory = Factory()
factory.register('A', ProductA)
factory.register('B', ProductB)

product_a = factory.create('A')
print(product_a.operation())  # Output: ProductA operation

product_b = factory.create('B')
print(product_b.operation())  # Output: ProductB operation
```

---

#### Node 2: Creation of Product Families in the Abstract Factory Pattern

**Function Description**: Create a set of related product objects through the abstract factory interface to ensure consistency among products.

**Core Algorithm**:
- Define the abstract factory interface.
- Each concrete factory implements methods to create a set of related products.
- The client obtains product instances through the factory interface.

**Input and Output Example**:

```python
from patterns.creational.abstract_factory import DogFactory, CatFactory

dog_factory = DogFactory()
dog = dog_factory.create_pet("Buddy")
print(dog.speak())  # Output: Woof!

cat_factory = CatFactory()
cat = cat_factory.create_pet("Kitty")
print(cat.speak())  # Output: Meow!
```

---

#### Node 3: Step-by-Step Construction in the Builder Pattern

**Function Description**: Decompose the construction process of a complex object into multiple steps, allowing each step to be customized as needed.

**Core Algorithm**:
- Define the abstract builder and declare the construction steps.
- Concrete builders implement each step.
- The director calls the builder's methods in order.

**Input and Output Example**:

```python
from patterns.creational.builder import HouseBuilder, Director

builder = HouseBuilder()
director = Director(builder)
house = director.construct()
print(house)  # Output: Floor: ... | Size: ...
```

---

#### Node 4: Object Cloning in the Prototype Pattern

**Function Description**: Create new objects by copying existing objects (prototypes), avoiding repeated initialization.

**Core Algorithm**:
- Define the prototype class and provide the clone method.
- Copy the object through clone and modify some attributes if necessary.

**Input and Output Example**:

```python
from patterns.creational.prototype import Prototype

proto = Prototype(value="origin", color="red")
clone = proto.clone(color="blue")
print(proto.value, proto.color)   # Output: origin red
print(clone.value, clone.color)   # Output: origin blue
```

---

#### Node 5: State Sharing in the Singleton/Borg Pattern

**Function Description**: Ensure that all instances share the same state, implementing a pseudo-singleton.

**Core Algorithm**:
- All instances share the same __dict__ or state.

**Input and Output Example**:

```python
from patterns.creational.borg import Borg

a = Borg()
b = Borg()
a.state = 1
print(b.state)  # Output: 1
```

---

#### Node 6: Interface Conversion in the Adapter Pattern

**Function Description**: Convert the interface of a class into another interface expected by the client, achieving system compatibility.

**Core Algorithm**:
- The adapter class holds a reference to the object to be adapted.
- Through the mapping of adapted methods, forward the new interface to the original object's methods.

**Input and Output Example**:

```python
from patterns.structural.adapter import Adapter

class Dog:
    def bark(self):
        return "Woof!"

class Cat:
    def meow(self):
        return "Meow!"

dog = Dog()
cat = Cat()
dog_adapter = Adapter(dog, make_noise=dog.bark)
cat_adapter = Adapter(cat, make_noise=cat.meow)

print(dog_adapter.make_noise())  # Output: Woof!
print(cat_adapter.make_noise())  # Output: Meow!
```

---

#### Node 7: Separation of Abstraction and Implementation in the Bridge Pattern

**Function Description**: Separate the abstraction (CircleShape) from the implementation (DrawingAPI1, DrawingAPI2), so that both can vary independently. The abstract class delegates the actual drawing operation to the implementation object.

**Core Algorithm**:
- The abstract class holds a reference to the implementation class interface.
- Complete specific operations through the implementation class.

**Input and Output Example**:

```python
from patterns.structural.bridge import DrawingAPI1, DrawingAPI2, CircleShape

circle1 = CircleShape(1, 2, 3, DrawingAPI1())
circle2 = CircleShape(4, 5, 6, DrawingAPI2())

circle1.draw()  # Internally calls DrawingAPI1.draw_circle
circle2.draw()  # Internally calls DrawingAPI2.draw_circle
```
**Test Verification(on provided example)**
- When circle1.draw() is called, DrawingAPI1.draw_circle should be invoked exactly once.

- When circle2.draw() is called, DrawingAPI2.draw_circle should be invoked exactly once.

---

#### Node 8: Management of Tree Structures in the Composite Pattern

**Function Description**: Combine objects into a tree structure to achieve unified management of the "part-whole" hierarchical structure.

**Core Algorithm**:
- Component nodes can recursively add/remove child nodes.
- Use a unified interface to traverse and operate all nodes.

**Input and Output Example**:

```python
from patterns.structural.composite import Component

root = Component("root")
child1 = Component("child1")
child2 = Component("child2")
root.add(child1)
root.add(child2)
child1.add(Component("leaf1"))
child2.add(Component("leaf2"))

root.display(0)
# Output:
# root
#   child1
#     leaf1
#   child2
#     leaf2
```

---

#### Node 9: Function Enhancement in the Decorator Pattern

**Function Description**: Dynamically add new functionality to an object without modifying its original structure.

**Core Algorithm**:
- Wrap the original object through a decorator class/function.
- Insert new functionality before and after the call.

**Input and Output Example**:

```python
from patterns.structural.decorator import decorate

class Text:
    def render(self):
        return "Hello"

def bold_decorator(component):
    class BoldWrapper:
        def render(self):
            return f"<b>{component.render()}</b>"
    return BoldWrapper()

text = Text()
bold_text = bold_decorator(text)
print(bold_text.render())  # Output: <b>Hello</b>

# Stacking decorators
italic_decorator = lambda c: type('Italic', (), {'render': lambda self: f'<i>{c.render()}</i>'})()
italic_bold_text = italic_decorator(bold_text)
print(italic_bold_text.render())  # Output: <i><b>Hello</b></i>
```

---

#### Node 10: Unified Interface in the Facade Pattern

**Function Description**: Provide a unified entry for a complex subsystem, simplifying client calls.

**Core Algorithm**:
- The facade class encapsulates multiple subsystem objects.
- The client only interacts with the facade.

**Input and Output Example**:

```python
from patterns.structural.facade import Facade

facade = Facade()
facade.operation()  # Output: Subsystem operation result
```

---

#### Node 11: Access Control in the Proxy Pattern

**Function Description**: Control access to the target object through a proxy object.

**Core Algorithm**:
- The proxy class holds a reference to the target object.
- The proxy can add control logic before and after access.

**Input and Output Example**:

```python
from patterns.structural.proxy import Proxy, RealSubject

real = RealSubject()
proxy = Proxy(real)
proxy.do_the_job("admin")  # Output: Real operation
proxy.do_the_job("guest")  # Output: Access denied
```

---

#### Node 12: Request Transmission in the Chain of Responsibility Pattern

**Function Description**: Pass a request along a chain of handlers until an object handles it.

**Core Algorithm**:
- Each handler holds a reference to the next handler.
- Handle the request or pass it to the next one.

**Input and Output Example**:

```python
from patterns.behavioral.chain_of_responsibility import ConcreteHandler1, ConcreteHandler2

h1 = ConcreteHandler1()
h2 = ConcreteHandler2()
h1.set_successor(h2)
h1.handle("request")  # Output: Handled by a certain handler
```

---

#### Node 13: Request Encapsulation in the Command Pattern

**Function Description**: Encapsulate an operation request as an object, enabling functions such as request queuing and undo.

**Core Algorithm**:
- The command object encapsulates the operation and the receiver.
- Call the execute method to execute.

**Input and Output Example**:

```python
from patterns.behavioral.command import Command, Receiver

receiver = Receiver()
command = Command(receiver)
command.execute()  # Output: Execution result
```

---

#### Node 14: Event Notification in the Observer Pattern

**Function Description**: Implement a one-to-many dependency relationship between objects. When the state of the observed object changes, automatically notify all registered observers.

**Core Algorithm**:
- Observers register/unregister.
- When the state of the observed object changes, traverse and notify all observers.

**Input and Output Example**:

```python
from patterns.behavioral.observer import Subject, Observer

class ConcreteObserver(Observer):
    def update(self, message):
        print(f"Received notification: {message}")

subject = Subject()
observer1 = ConcreteObserver()
observer2 = ConcreteObserver()

subject.attach(observer1)
subject.attach(observer2)
subject.notify("Event occurred")
# Output:
# Received notification: Event occurred
# Received notification: Event occurred
```

---

#### Node 15: Algorithm Switching in the Strategy Pattern

**Function Description**: Encapsulate algorithms into independent classes and allow them to be dynamically switched at runtime.

**Core Algorithm**:
- Define the strategy interface.
- Multiple strategies implement the same interface.
- The context holds a reference to the strategy.

**Input and Output Example**:

```python
from patterns.behavioral.strategy import Context, StrategyA, StrategyB

context = Context(StrategyA())
print(context.execute())  # Output: Result of Strategy A
context.set_strategy(StrategyB())
print(context.execute())  # Output: Result of Strategy B
```

---

#### Node 16: Algorithm Skeleton in the Template Method Pattern

**Function Description**: Define the algorithm flow and defer some steps to subclasses for implementation.

**Core Algorithm**:
- The abstract class implements the main algorithm flow.
- Subclasses implement specific steps.

**Input and Output Example**:

```python
from patterns.behavioral.template import ConcreteClass

obj = ConcreteClass()
obj.template_method()  # Output: Order of step execution
```

---

#### Node 17: Data Structure Operations in the Visitor Pattern

**Function Description**: Perform operations on elements in a data structure and support the extension of new operations.

**Core Algorithm**:
- The element class accepts(visitor).
- The visitor class visits(element).

**Input and Output Example**:

```python
from patterns.behavioral.visitor import ConcreteElement, ConcreteVisitor

element = ConcreteElement()
visitor = ConcreteVisitor()
element.accept(visitor)  # Output: Result of the visitor's operation
```

---

#### Node 18: Subclass Tracking in the Registry Pattern

**Function Description**: Automatically record all subclasses for unified management and searching.

**Core Algorithm**:
- The metaclass registers classes to the global dictionary when creating them.

**Input and Output Example**:

```python
from patterns.behavioral.registry import RegistryHolder

print(RegistryHolder.get_registry())  # Output: All registered subclasses
```

---

#### Node 19: Parameter Dispatching in the Catalog Pattern

**Function Description**: Select different static methods to execute according to parameters.

**Core Algorithm**:
- A dictionary mapping parameters to methods.
- The main_method calls the corresponding method according to the parameter.

**Input and Output Example**:

```python
from patterns.behavioral.catalog import Catalog

catalog = Catalog("param_value_1")
catalog.main_method()  # Output: executed method 1!
```

---

#### Node 20: Common Service in the Servant Pattern

**Function Description**: Provide common geometry-related services (such as area, perimeter, and position updates) for different shape objects without requiring them to inherit from a common base class.

**Core Algorithm**:
- Define a **Servant class** (`GeometryTools`) that implements multiple static service methods.
- Pass the target object (e.g., `Circle`, `Rectangle`) as a parameter to these methods.
- The Servant executes the requested operation (area, perimeter, move) on behalf of the object.

**Class Signatures**:
```python
class GeometryTools:
    @staticmethod
    def calculate_area(shape)

    @staticmethod
    def calculate_perimeter(shape)

    @staticmethod
    def move_to(shape, new_position: Position)
```

---

#### Node 21: Business Rule Combination in the Specification Pattern

**Function Description**: Combine business rules through boolean logic.

**Core Algorithm**:
- The specification class implements the is_satisfied_by method.
- Can be combined with AND/OR/NOT.

**Input and Output Example**:

```python
from patterns.behavioral.specification import Specification, AndSpecification

spec1 = Specification(...)
spec2 = Specification(...)
and_spec = AndSpecification(spec1, spec2)
print(and_spec.is_satisfied_by(candidate))  # Output: True/False
```

---

#### Node 22: Decoupling in Dependency Injection

**Function Description**: Decouple components by injecting dependencies.

**Core Algorithm**:
- Pass the dependency object to the target object as a parameter.

**Input and Output Example**:

```python
from patterns.dependency_injection import inject

inject(dependency, target)
```

---

#### Node 23: Expert Collaboration in the Blackboard Pattern

**Function Description**: Multiple expert systems collaborate to solve complex problems.

**Core Algorithm**:
- Each expert implements the contribute method.
- The blackboard object coordinates expert collaboration.

**Input and Output Example**:

```python
from patterns.other.blackboard import AbstractExpert, Blackboard

class MyExpert(AbstractExpert):
    def is_eager_to_contribute(self):
        return True
    def contribute(self):
        print("Contributing knowledge")

blackboard = Blackboard()
expert = MyExpert(blackboard)
expert.contribute()  # Output: Contributing knowledge
```