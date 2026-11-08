# Bibelstudium

Eine schlichte, dunkle Web-App zum Bibelstudium im Split-Screen:
**links Notizen** (Tastatur oder Apple Pencil), **rechts die Bibel**.

## Funktionen

**Bibel (rechts)**
- Inhaltsverzeichnis mit allen 66 Büchern und Kapiteln (Tippen auf den Stellen-Knopf oben)
- Schnellsprung per Eingabe: `1Mo 5`, `1. Mose 4`, `Joh 3,16`, `Röm 8,28-30`, `Ps 23`
- Zurück/Vorwärts-Verlauf, Kapitel blättern (auch mit ← → auf der Tastatur)
- Volltextsuche (ganze Bibel, AT, NT oder aktuelles Buch)
- Vers antippen → Vers ist ausgewählt; zweiten Vers antippen → Bereich (z. B. 16–18)
- Am Desktop geht auch normales Markieren mit der Maus

**Nach dem Auswählen erscheint ein Menü**
- **Notiz erstellen**: neue Notiz mit der Bibelstelle als Block
- **In offene Notiz**: Stelle in die gerade geöffnete Notiz einfügen
- **Ziehen**: gedrückt halten und auf das Notizfeld ziehen (Maus, Finger oder Pencil)
- **Markieren**: farbig markieren, ohne Notiz

**Notizen (links)**
- Modus **Text**: Titel, Überschriften, Schriftgröße A−/A+, fett/kursiv/unterstrichen,
  Textmarker, Schriftfarbe, Listen, Checklisten, Zitate, farbige **Blöcke**, Trennlinien
- Blöcke (Bibelstellen, farbige Blöcke, Zitate) lassen sich verschieben (↑ ↓), umfärben,
  duplizieren und löschen
- Modus **Stift**: frei schreiben und zeichnen mit dem Apple Pencil (druckempfindlich),
  Textmarker, Radierer, Farben, Strichstärken.
  „Nur Pencil“: Der Stift zeichnet, mit dem Finger scrollst du.
- Tipp: Mit Apple Pencil *Scribble* kannst du im Text-Modus auch handschriftlich tippen.

**Notizverzeichnis (☰ oben links)**
- Alle Notizen mit ihren Bibelstellen; ein Tipp öffnet die Notiz **und springt rechts zur Stelle**
- Reiter „Bibelstellen“: alle markierten Stellen in biblischer Reihenfolge
- Stellen mit Notiz sind in der Bibel farbig hinterlegt und tragen ein kleines Notiz-Symbol.
  Tippst du darauf, öffnet sich die Notiz.

## Übersetzungen

Eingebaut ist die **Elberfelder 1905** (gemeinfrei). Die Schlachter 2000 ist
urheberrechtlich geschützt und deshalb nicht enthalten.

Eigene Bibel importieren: **Einstellungen → Bibel-Datei importieren**. Das geht mit
**Zefania-XML**, **OSIS-XML** und gängigen **JSON**-Formaten. Die importierte Bibel
bleibt nur auf deinem Gerät und wird nirgends hochgeladen.

## Daten & Sicherung

Notizen, Zeichnungen und Markierungen werden automatisch im Browser gespeichert
(IndexedDB), und zwar nur auf diesem Gerät. Unter **Einstellungen → Sicherung** kannst
du alles als Datei herunterladen und wieder einspielen, zum Beispiel für ein anderes Gerät.

## Starten

Es ist kein Build nötig, nur ein einfacher Webserver:

```bash
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

**Aufs iPad:** Die App über GitHub Pages (oder einen anderen Webserver) veröffentlichen,
in Safari öffnen und **Teilen → Zum Home-Bildschirm** wählen. Dann startet sie wie eine
App im Vollbild und funktioniert danach auch offline.
