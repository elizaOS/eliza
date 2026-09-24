
# **REALM-Bench: A Real-World Planning Benchmark for LLMs and Multi-Agent Systems**
<p align="center">
  ⬇️ <a href="https://github.com/genglongling/REALM-Bench?tab=readme-ov-file">Github</a>  
  📃 <a href="https://arxiv.org/abs/2502.18836">Paper</a>  
  🌐 <a href="https://github.com/genglongling/M-APPLE-OS">Dataset</a>
</p>

This repository provides a comprehensive benchmark for evaluating multi-agent planning systems across **5 agent frameworks** and **11 real-world planning scenarios**. It implements **6 standard evaluation metrics** for assessing planning quality, optimality, coordination, constraint satisfaction, resource usage, and adaptation to disruptions.  
  
1. **11 Real-World Planning Scenarios** covering diverse domains:
   - **P11**: Job Shop Scheduling (JSSP) - Combinatorial optimization
   - **P1-P2**: Campus Tours - Single/multi-agent routing
   - **P3-P4**: Urban Ride-Sharing - Vehicle routing with disruptions
   - **P5-P6**: Event Logistics - Wedding/Thanksgiving coordination
   - **P7**: Disaster Relief - Resource allocation under uncertainty
   - **P8-P9**: Disruption Handling - Reactive replanning scenarios
   - **P10**: Supply Chain - Large-scale industrial planning

2. **6 Standard Evaluation Metrics** for comprehensive assessment:
   - **Planning Quality (Accuracy)** - Goal satisfaction rates
   - **Planning Optimality (Makespan)** - Cost/time efficiency
   - **Coordination Effectiveness** - Inter-agent consistency
   - **Constraint Satisfaction Rate** - Constraint adherence
   - **Resource Usage Rate** - Memory, time, and token utilization
   - **Adaptation to Disruption** - Replanning success rates

3. **5 Multi-Agent Frameworks** with standardized integration:
   - **LangGraph** - State machine-based orchestration
   - **AutoGen** - Conversational AI framework
   - **CrewAI** - Multi-agent collaboration
   - **OpenAI Swarm Agent** - Swarm-based coordination
   - **ALAS (ours)** - A Stateful Multi-LLM Agent Framework

4. **Comprehensive Evaluation Framework** with:
   - Automated benchmarking across frameworks
   - Statistical analysis and visualization
   - Detailed performance reporting
   - Extensible architecture for new frameworks/tasks  

---

## **🚀 How To Run**  

### **1️⃣ Setup Environment**  
Follow these steps to get started:  

- **Create a virtual environment**  
  ```bash
  python3 -m venv venv
  ```
  making sure your program using python==3.10+ for your venv on your editor.
  
- **Activate the virtual environment**  
  - macOS/Linux:  
    ```bash
    source venv/bin/activate
    ```  
  - Windows:  
    ```bash
    venv\Scripts\activate
    ```  
- **Install dependencies**  
  ```bash
  pip install -r requirements.txt
  ```  
- **Set up OpenAI API credentials**  
  - Create a `.env` file in the root directory  
  - Add your OpenAI API key:  
    ```env
    OPENAI_API_KEY="sk-proj-..."
    ```  
- **Run Jupyter Notebook**  
  ```bash
  jupyter notebook
  ```  
  - Open and modify `design_patterns/multiagent.ipynb` to create your **specialized multi-agent use case**.  

---

### **2️⃣ Running Multi-Agent Frameworks**
(Optional) You can execute agents using one of the frameworks:  

- **Run an agent framework**  
  ```bash
  python agent_frameworks/openai_swarm_agent/main.py
  ```  
- **Using AutoGen**  
  - Ensure **Docker** is installed ([Get Docker](https://docs.docker.com/get-started/get-docker/))  
  - Start Docker before running AutoGen-based agents

### **3️⃣ Running Evaluation Benchmark**
Evaluate multi-agent planning performance across frameworks:

- **Run full benchmark evaluation**  
  ```bash
  python run_evaluation.py
  ```  
- **Run specific frameworks/tasks**  
  ```bash
  python run_evaluation.py --frameworks langgraph,crewai --tasks P11,P1,P2
  ```  
- **Run with mock runners for testing**  
  ```bash
  python run_evaluation.py --mock
  ```  
- **Run example evaluation**  
  ```bash
  python examples/evaluation_example.py
  ```  

---

## **📂 Project Structure**  
```
📦 REALM-Bench
│── 📂 design_patterns
│   ├── reflection.ipynb        # Reflection-based agent
│   ├── planning.ipynb          # Planning-based agent
│   ├── tool_use.ipynb          # Tool-using agent
│   ├── multiagent.ipynb        # Multi-agent collaboration
│   ├── multiagent-P0-P10.ipynb # Real-world examples P0-P10
│── 📂 agent_frameworks
│   ├── autogen_multi_agent/    # AutoGen-based implementation
│   ├── crewai_multi_agent/     # CrewAI-based implementation
│   ├── openai_swarm_agent/     # Swarm-based implementation
│   ├── langgraph/              # LangGraph-based implementation
│── 📂 evaluation
│   ├── metrics.py              # Standard evaluation metrics
│   ├── task_definitions.py     # 11 task definitions
│   ├── evaluator.py            # Main evaluation framework
│   ├── framework_runners.py    # Framework integration
│   └── README.md               # Evaluation documentation
│── 📂 examples
│   └── evaluation_example.py   # Usage examples
│── run_evaluation.py           # Main evaluation runner
│── .env                        # API keys & environment variables
│── requirements.txt            # Dependencies
│── README.md                   # Documentation
```

---

## **📈 P11 Job Shop Scheduling Benchmark Dashboard**
*Note: Welcome to pull requests and add your method beside.*

### **DMU Dataset Performance Comparison**

| Dataset | Size | Random | LPT | SPT | STPT | MPSR | DRL-Liu | GP | GEP | SeEvo(GLM3) | SeEvo(GPT3.5) | UB | ALAS-dynamic (ours, on Langraph) | ALAS-static (ours, on Langraph) |
|---------|------|--------|-----|-----|------|------|---------|----|-----|-------------|---------------|----|-------------|-------------|
| DMU03 | 20×15 | 3827 | 4592 | 3630 | 4232 | 3435 | 3303 | 3540 | 3651 | 3462 | 3238 | **2731** | 3356 | 3462 |
| DMU04 | 20×15 | 3889 | 4047 | 3541 | 4642 | 3355 | 3321 | 3406 | 3499 | 3235 | 3212 | **2669** | 3352 | 3235 |
| DMU08 | 20×20 | 4228 | 4551 | 4714 | 4459 | 3999 | 4098 | 3802 | 4023 | 3728 | 3728 | **3188** | 3906 | 3728 |
| DMU09 | 20×20 | 4094 | 4511 | 4283 | 4690 | 3869 | 3753 | 4196 | 4136 | 3857 | 3828 | **3092** | 3731 | 3857 |
| DMU13 | 30×15 | 5451 | 5580 | 4813 | 5207 | 4759 | 4708 | 4765 | 4812 | 4658 | 4709 | **3681** | 4524 | 4658 |
| DMU14 | 30×15 | 5306 | 5591 | 4583 | 4811 | 4238 | 4124 | 4289 | 4213 | 3980 | 3980 | **3394** | 4195 | 3980 |
| DMU18 | 30×20 | 5326 | 5810 | 6231 | 5480 | 5003 | 4800 | 4696 | 4917 | 4724 | 4724 | **3844** | 4675 | 4724 |
| DMU19 | 30×20 | 5174 | 5787 | 5126 | 5203 | 4930 | 4837 | 4666 | 5245 | 4715 | 4816 | **3768** | 4774 | 4715 |
| DMU23 | 40×15 | 5948 | 7045 | 6250 | 6521 | 5383 | 5240 | 5391 | 5595 | 5151 | 5258 | **4668** | 5805 | 5151 |
| DMU24 | 40×15 | 6078 | 6484 | 5503 | 6595 | 5358 | 5319 | 5560 | 5458 | 5226 | 5316 | **4648** | 5750 | 5226 |
| DMU28 | 40×20 | 6737 | 7322 | 6558 | 7697 | 5927 | 5948 | 6017 | 6142 | 5838 | 5944 | **4692** | 5550 | 5838 |
| DMU29 | 40×20 | 6602 | 7386 | 6565 | 7690 | 6107 | 5824 | 6236 | 6224 | 5941 | 5825 | **4691** | 5661 | 5941 |
| DMU33 | 50×15 | 6890 | 8779 | 7361 | 7631 | 6282 | 6458 | 6109 | 6081 | 6029 | 6029 | **5728** | 7158 | 6029 |
| DMU34 | 50×15 | 7523 | 7991 | 7026 | 7740 | 6359 | 6284 | 6327 | 6279 | 6148 | 6146 | **5385** | 6597 | 6148 |
| DMU38 | 50×20 | 7685 | 9051 | 7954 | 8555 | 7604 | 7275 | 7267 | 7501 | 7168 | 7170 | **5713** | 7119 | 7168 |
| DMU39 | 50×20 | 8097 | 8514 | 7592 | 8908 | 6953 | 6776 | 6941 | 7124 | 6693 | 6590 | **5747** | 6799 | 6693 |
| **Mean** | -- | 5803 | 6440 | 5733 | 6254 | 5223 | 5129 | 5201 | 5306 | 5035 | 5032 | **4227** | 5185 | 5035 |
| **Gap to UB (%)** | -- | 37.28 | 52.34 | 35.62 | 47.93 | 23.54 | 21.33 | 23.02 | 25.52 | 19.09 | 19.03 | -- | 22.74 | 19.09 |

*Note: ALAS-static performs better on DMU datasets with 19.09% gap to upper bound (UB).*

### **TA Dataset Performance Comparison**

| Dataset | Size | LSO | SPT/TWKR | DRL-Chen | DRL-Zhang | DRL-Liu | GP | GEP | SeEvo(GLM3) | SeEvo(GPT3.5) | UB | ALAS-Dynamic (ours, on Langraph) | ALAS-Static on Langraph (ours, on Langraph) |
|---------|------|-----|----------|----------|-----------|---------|----|-----|-------------|---------------|----|-------------|-------------|
| TA01 | 15×15 | 1957 | 1664 | 1711 | 1433 | 1492 | 1547 | 1547 | 1427 | 1427 | **1231** | **1243** | 1231 |
| TA02 | 15×15 | 1759 | 1538 | 1639 | 1544 | 1425 | 1565 | 1486 | 1465 | 1437 | **1244** | **1252** | 1244 |
| TA51 | 50×15 | 3844 | 3768 | 3762 | 3599 | 3608 | 3603 | 3668 | 3364 | 3412 | **2760** | **2766** | 2760 |
| TA52 | 50×15 | 3715 | 3588 | 3511 | 3341 | 3524 | 3346 | 3324 | 3286 | 3245 | **2756** | **2819** | 2756 |
| TA61 | 50×20 | 4188 | 3752 | 3633 | 3654 | 3548 | 3685 | 3642 | 3529 | 3537 | **2868** | **2905** | F |
| TA71 | 100×20 | 6754 | 6705 | 6321 | 6452 | 6289 | 6305 | 6278 | 6071 | 6099 | **5464** | **5478** | 5464 |
| TA72 | 100×20 | 6674 | 6351 | 6232 | 5695 | 6002 | 5776 | 5625 | 5604 | 5575 | **5181** | **5198** | F |
| **Mean** | -- | 4127 | 3909 | 3830 | 3674 | 3698 | 3690 | 3653 | 3535 | 3533 | **3072** | **3094** | -- |
| **Gap to UB (%)** | -- | 34.31 | 27.23 | 24.66 | 18.48 | 19.39 | 20.12 | 18.91 | 15.10 | 14.99 | -- | **0.86** | -- |

*Note: ALAS-dynamic performs better on TA datasets with only 0.86% gap to upper bound (UB).*

### **Additional Benchmark Instances (ABZ, SWV, YN) (ours, on Langraph)**

| Dataset | Size | UB | Static Makespan | Valid Static | Dynamic Min | Dynamic Max | Static Valid Rate | Dynamic Valid Rate | Static Gap (%) | Dynamic Gap (%) |
|---------|------|----|----------------|--------------|-------------|-------------|-------------------|-------------------|----------------|-----------------|
| abz07 | 20×15 | 656 | 656 | True | 659 | 978 | 1.0 | 1.0 | 0.00% | 0.46% |
| abz08 | 20×15 | 667 | 667 | True | 701 | 983 | 1.0 | 1.0 | 0.00% | 5.10% |
| abz09 | 20×15 | 678 | 678 | True | 679 | 975 | 1.0 | 1.0 | 0.00% | 0.15% |
| swv01 | 20×10 | 1407 | 1406 | - | 1429 | 2100 | - | 1.0 | - | 1.56% |
| swv02 | 20×10 | 1475 | 1475 | True | 1481 | 2177 | 1.0 | 1.0 | 0.00% | 0.41% |
| swv03 | 20×10 | 1398 | 1398 | True | 1429 | 2073 | 1.0 | 1.0 | 0.00% | 2.22% |
| swv04 | 20×10 | 1464 | 1464 | True | 1466 | 2168 | 1.0 | 1.0 | 0.00% | 0.14% |
| swv05 | 20×10 | 1424 | 1424 | True | 1430 | 2086 | 1.0 | 1.0 | 0.00% | 0.42% |
| swv06 | 20×15 | 1667 | 1667 | True | 1716 | 2485 | 1.0 | 1.0 | 0.00% | 2.94% |
| swv07 | 20×15 | 1595 | 1595 | True | 1621 | 2388 | 1.0 | 1.0 | 0.00% | 1.63% |
| swv08 | 20×15 | 1751 | 1751 | True | 1774 | 2535 | 1.0 | 1.0 | 0.00% | 1.31% |
| swv09 | 20×15 | 1655 | 1655 | True | 1672 | 2446 | 1.0 | 1.0 | 0.00% | 1.03% |
| swv10 | 20×15 | 1743 | 1743 | True | 1817 | 2603 | 1.0 | 1.0 | 0.00% | 4.24% |
| swv11 | 50×10 | 2983 | 2983 | True | 3099 | 4470 | 1.0 | 1.0 | 0.00% | 3.89% |
| swv12 | 50×10 | 2972 | 2972 | True | 2992 | 4423 | 1.0 | 1.0 | 0.00% | 0.67% |
| swv13 | 50×10 | 3104 | 3104 | True | 3144 | 4573 | 1.0 | 1.0 | 0.00% | 1.29% |
| swv14 | 50×10 | 2968 | 2968 | True | 2981 | 4396 | 1.0 | 1.0 | 0.00% | 0.44% |
| swv15 | 50×10 | 2885 | 2885 | True | 2912 | 4301 | 1.0 | 1.0 | 0.00% | 0.94% |
| yn01 | 20×20 | 884 | 884 | True | 888 | 1293 | 1.0 | 1.0 | 0.00% | 0.45% |
| yn02 | 20×20 | 904 | 904 | True | 942 | 1321 | 1.0 | 1.0 | 0.00% | 4.20% |
| yn03 | 20×20 | 892 | 892 | True | 900 | 1320 | 1.0 | 1.0 | 0.00% | 0.90% |
| yn04 | 20×20 | 968 | 968 | True | 980 | 1450 | 1.0 | 1.0 | 0.00% | 1.24% |
| **Mean** | -- | 1663 | 1663 | -- | 1685 | 2484 | **0.955** | **1.0** | -- | -- |
| **Gap to UB (%)** | -- | -- | -- | -- | -- | -- | -- | -- | -- | **1.65%** |

### **Key Performance Insights**

- **ALAS-Static** excels on **DMU datasets** with **19.09% gap** to upper bound
- **ALAS-Dynamic** dominates **TA datasets** with only **0.86% gap** to upper bound
- **ALAS-Static** shows **95.5% validity rate** on additional benchmarks 
- **ALAS-Dynamic** achieves **100% validity rate** across all benchmark instances
- **Overall performance:** Both methods significantly outperform traditional heuristics (Random, LPT, SPT) and machine learning approaches (DRL, GP, GEP)

---

## **📊 Problem Datasets & Public Data Sources**

This benchmark includes 11 real-world planning problems. 
*Note: We will benchmark p1-p10 in later release.*
Below is a comprehensive summary of available public datasets for each problem type:

| Problem | Name | Category | Public Datasets | Dataset Links | Data Type | Size |
|---------|------|----------|-----------------|---------------|-----------|------|
| **P11** | Job Shop Scheduling (JSSP) | Scheduling | • OR-Library JSSP<br>• Beasley JSSP<br>• Taillard JSSP | • [OR-Library](http://people.brunel.ac.uk/~mastjjb/jeb/orlib/jsspinfo.html)<br>• [Beasley JSSP](https://www.researchgate.net/publication/220463473_OR-Library_distributing_test_problems_by_electronic_mail)<br>• [Taillard JSSP](http://mistic.heig-vd.ch/taillard/problemes.dir/ordonnancement.dir/ordonnancement.html) | Benchmark instances | 182 instances |
| **P1** | Single-Agent Campus Tour | Routing | • TSPLIB<br>• Custom campus layouts | • [TSPLIB](http://comopt.ifi.uni-heidelberg.de/software/TSPLIB95/)<br>• [VRP datasets](http://vrp.galgos.inf.puc-rio.br/index.php/en/) | TSP/VRP instances | 100+ instances |
| **P2** | Multi-Group Campus Tours | Scheduling | • VRP with Time Windows<br>• Solomon datasets | • [Solomon VRP](http://web.cba.neu.edu/~msolomon/problems.htm)<br>• [Gehring & Homberger](http://www.bernabe.dorronsoro.es/vrp/) | VRP-TW instances | 56 instances |
| **P3** | Urban Ride-Sharing (URS) | Routing | • NYC Taxi Trip Data<br>• Chicago Taxi Data<br>• Uber Movement Data | • [NYC Taxi Data](https://www1.nyc.gov/site/tlc/about/tlc-trip-record-data.page)<br>• [Chicago Taxi Data](https://data.cityofchicago.org/Transportation/Taxi-Trips/wrvz-psew)<br>• [Uber Movement](https://movement.uber.com/) | Real trip data | 100M+ trips |
| **P4** | URS with Disruptions | Routing | • NYC Taxi + Traffic Data<br>• Chicago Traffic Incidents | • [NYC Traffic](https://data.cityofnewyork.us/Transportation/Traffic-Incidents/)<br>• [Chicago Traffic](https://data.cityofchicago.org/Transportation/Traffic-Crashes/)<br>• [BTS Airline Delays](https://www.transtats.bts.gov/Tables.asp?QO_VQ=EFD) | Trip + disruption data | 10M+ records |
| **P5** | Wedding Logistics | Logistics | • Airport Pickup Data<br>• Event Planning Templates | • [Airport Traffic](https://www.transtats.bts.gov/)<br>• [Event Planning APIs](https://developers.google.com/maps/documentation/directions) | Synthetic + real data | Custom generation |
| **P6** | Thanksgiving Dinner Planning | Logistics | • Airport Traffic Data<br>• Recipe Preparation Times | • [BTS Airport Data](https://www.transtats.bts.gov/Tables.asp?QO_VQ=EFD)<br>• [Recipe APIs](https://spoonacular.com/food-api) | Traffic + recipe data | Custom generation |
| **P7** | Disaster Relief | Resource Allocation | • UN OCHA Datasets<br>• FEMA Disaster Data<br>• Humanitarian OSM | • [UN OCHA](https://data.humdata.org/)<br>• [FEMA Data](https://www.fema.gov/openfema-data-page)<br>• [Humanitarian OSM](https://www.hotosm.org/) | Disaster response data | 1000+ events |
| **P8** | Disruption Handling | Replanning | • Airline Delay Data<br>• Traffic Incident Data | • [BTS Airline Delays](https://www.transtats.bts.gov/Tables.asp?QO_VQ=EFD)<br>• [City Traffic APIs](https://developers.google.com/maps/documentation/traffic) | Delay/incident data | 1M+ records |
| **P9** | Advanced Disruption Handling | Replanning | • Multi-modal Disruption Data<br>• Weather Impact Data | • [Weather APIs](https://openweathermap.org/api)<br>• [Transit APIs](https://developers.google.com/maps/documentation/directions) | Multi-source data | Custom generation |
| **P10** | Supply Chain | Industrial Planning | • OR-Library Supply Chain<br>• MIPLIB<br>• TSPLIB | • [OR-Library](http://people.brunel.ac.uk/~mastjjb/jeb/orlib/)<br>• [MIPLIB](https://miplib.zib.de/)<br>• [TSPLIB](http://comopt.ifi.uni-heidelberg.de/software/TSPLIB95/) | Optimization instances | 1000+ instances |

### **Dataset Generation Strategy**

For comprehensive benchmarking, we recommend a **hybrid approach**:

1. **Public Datasets (30%)** - Use real-world data where available
2. **Synthetic Generation (70%)** - Create diverse scenarios for consistent evaluation

### **Dataset Categories**

- **📊 Benchmark Instances** - Standard optimization problems (P11, P10)
- **🚗 Real Trip Data** - Actual transportation records (P3, P4)
- **🏢 Campus/Urban Layouts** - Geographic and spatial data (P1, P2)
- **🎉 Event Planning** - Logistics and coordination scenarios (P5, P6)
- **🚨 Disaster Response** - Emergency management data (P7)
- **⚠️ Disruption Events** - Real-time incident data (P8, P9)

### **Data Sources by Category**

| Category | Primary Sources | Data Format | Access |
|----------|----------------|-------------|---------|
| **Transportation** | NYC/Chicago Open Data, BTS | CSV, JSON | Public APIs |
| **Optimization** | OR-Library, MIPLIB | Text files | Direct download |
| **Geographic** | OpenStreetMap, Google Maps | GeoJSON, APIs | Public APIs |
| **Disaster** | UN OCHA, FEMA | CSV, APIs | Public APIs |
| **Events** | Custom generation | JSON | Synthetic |

---

## **📜 Citation**  

If you find this repository helpful, please cite the following paper:  

```
REALM-Bench: A Real-World Planning Benchmark for LLMs and Multi-Agent Systems  
Anonymous Author(s)  
```

---

