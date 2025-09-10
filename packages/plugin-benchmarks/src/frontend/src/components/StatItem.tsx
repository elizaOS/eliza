interface StatItemProps {
  stat: {
    value: string
    label: string
  }
}

const StatItem: React.FC<StatItemProps> = ({ stat }) => {
  return (
    <div className="text-center p-4 bg-secondary rounded-lg">
      <span className="block text-3xl font-bold text-primary mb-1">{stat.value}</span>
      <div className="text-sm text-muted-foreground">{stat.label}</div>
    </div>
  )
}

export default StatItem
