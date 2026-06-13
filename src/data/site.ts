export const categories = [
  { id: "zpravy", label: "Zprávy" },
  { id: "kultura", label: "Kultura" },
  { id: "sport", label: "Sport" },
  { id: "akce", label: "Akce" },
  { id: "servis", label: "Servis" }
] as const;

export type CategoryId = typeof categories[number]["id"];

export const selectedEvents = [
  {
    title: "Znojmo žije divadlem",
    date: "24.–27. června",
    place: "Znojmo",
    source: "Znojemská Beseda",
    url: "https://znojemskabeseda.com/"
  },
  {
    title: "Laboratoř zvuků",
    date: "do 30. září",
    place: "Loucký klášter",
    source: "Znojemská Beseda",
    url: "https://znojemskabeseda.com/"
  },
  {
    title: "Program Kina Svět",
    date: "denní program",
    place: "Kino Svět",
    source: "Kino Znojmo",
    url: "https://www.kinoznojmo.cz/"
  }
] as const;
