# The Mathematical Model
This document provides a complex number based mathematical model.
## Sets and Parameters
### Sets

$$
\begin{aligned}
& N \text{ : buses} \\
& R \text{ : reference buses} \\
& E, E^R \text{ : branches, forward and reverse orientation} \\
& G, G_i \text{ : generators and generators at bus } i \\
& L, L_i \text{ : loads and loads at bus } i \\
& S, S_i \text{ : shunts and shunts at bus } i \\
\end{aligned}
$$

### Parameters

$$
\begin{aligned}
& S^{gl}_k, S^{gu}_k \quad \forall k \in G  \text{ : generator complex power bounds} \\
& c_{2k}, c_{1k}, c_{0k} \quad \forall k \in G \text{ : generator cost components} \\
& v^l_i, v^u_i \quad \forall i \in N \text{ : voltage bounds} \\
& S^d_k \quad \forall k \in L \text{ : load complex power consumption} \\
& Y^s_k \quad \forall k \in S \text{ : bus shunt admittance} \\
& Y_{ij}, Y^c_{ij}, Y^c_{ji} \quad \forall (i,j) \in E \text{ : branch }\pi\text{-section parameters} \\
& T_{ij} \quad \forall (i,j) \in E \text{ :  branch complex transformation ratio} \\
& s^u_{ij} \quad \forall (i,j) \in E \text{ : branch apparent power limit} \\
& i^u_{ij} \quad \forall (i,j) \in E \text{ : branch current limit} \\
& \theta^{\Delta l}_{ij}, \theta^{\Delta u}_{ij} \quad \forall (i,j) \in E \text{ : branch voltage angle difference bounds}
\end{aligned}
$$


## Mathmatical Model

A complete mathematical model is as follows,
### Variables
$$
\begin{aligned}
& S^g_k \quad \forall k\in G  \text{ : generator complex power dispatch} \\
& V_i \quad \forall i\in N  \text{ : bus complex voltage} \\
& S_{ij} \quad \forall (i,j) \in E \cup E^R \text{ : branch complex power flow} \\
\\
\end{aligned}
$$

### Formulation
$$
\begin{aligned}
\text{minimize:} &  
\sum_{k \in G} c_{2k} (\Re(S^g_k))^2 + c_{1k}\Re(S^g_k) + c_{0k} \\

\text{subject to:} & \\
& \angle V_{r} = 0 \quad \forall r \in R \\
& S^{gl}_k \leq S^g_k \leq S^{gu}_k \quad \forall k \in G \\
& v^l_i \leq |V_i| \leq v^u_i \quad \forall i \in N \\
& \sum_{k \in G_i} S^g_k - \sum_{k \in L_i} S^d_k - \sum_{k \in S_i} (Y^s_k)^* |V_i|^2 = \sum_{(i,j)\in E_i \cup E_i^R} S_{ij} \quad \forall i\in N \\
& S_{ij} = (Y_{ij} + Y^c_{ij})^* \frac{|V_i|^2}{|T_{ij}|^2} - Y^*_{ij} \frac{V_i V^*_j}{T_{ij}} \quad \forall (i,j)\in E \\
& S_{ji} = (Y_{ij} + Y^c_{ji})^* |V_j|^2 - Y^*_{ij} \frac{V^*_i V_j}{T^*_{ij}} \quad \forall (i,j)\in E \\
& |S_{ij}| \leq s^u_{ij} \quad \forall (i,j) \in E \cup E^R \\
& |S_{ij}| \leq |V_i| i^u_{ij} \quad \forall (i,j) \in E \cup E^R \\
& \theta^{\Delta l}_{ij} \leq \angle (V_i V^*_j) \leq \theta^{\Delta u}_{ij} \quad \forall (i,j) \in E
\end{aligned}
$$
