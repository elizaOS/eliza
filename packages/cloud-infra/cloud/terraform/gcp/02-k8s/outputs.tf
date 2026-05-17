output "namespaces" {
  description = "Created Kubernetes namespaces"
  value       = [for ns in kubernetes_namespace.namespaces : ns.metadata[0].name]
}
