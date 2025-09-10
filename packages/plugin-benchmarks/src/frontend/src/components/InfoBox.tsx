interface InfoBoxProps {
  title: string
  content: string
}

const InfoBox: React.FC<InfoBoxProps> = ({ title, content }) => {
  return (
    <div className="bg-card border border-primary/20 rounded-lg p-4 mt-6">
      <h3 className="text-primary font-medium mb-2">{title}</h3>
      <p className="text-muted-foreground text-sm leading-relaxed">{content}</p>
    </div>
  )
}

export default InfoBox
