from pathlib import Path
here = Path(__file__).resolve().parent
path = here / "mind_snap.html"

text = path.read_text(encoding="utf-8")
start = text.index('  <section id= home class=hero>')
end = text.index('  <div class=app-shell', start)
text = text[:start] + text[end:]
path.write_text(text, encoding="utf-8")
