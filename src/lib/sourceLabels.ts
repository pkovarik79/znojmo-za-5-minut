export function sourceLabel(sourceName: string) {
  const labels: Record<string, string> = {
    "Město Znojmo": "Znojmocity.cz"
  };

  return labels[sourceName] ?? sourceName;
}
