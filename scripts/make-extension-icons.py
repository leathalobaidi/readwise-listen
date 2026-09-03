from pathlib import Path
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "public" / "icons"
OUTPUT.mkdir(parents=True, exist_ok=True)


def make_icon(size: int) -> None:
    scale = 4
    canvas_size = size * scale
    image = Image.new("RGBA", (canvas_size, canvas_size), "#173a31")
    draw = ImageDraw.Draw(image)

    orange = "#ef5b36"
    white = "#fffdf8"
    margin = int(canvas_size * 0.2)

    draw.rectangle((0, int(canvas_size * 0.86), canvas_size, canvas_size), fill=orange)
    triangle = [
        (int(canvas_size * 0.42), int(canvas_size * 0.29)),
        (int(canvas_size * 0.42), int(canvas_size * 0.71)),
        (int(canvas_size * 0.72), int(canvas_size * 0.50)),
    ]
    draw.polygon(triangle, fill=white)

    line_width = max(scale, int(canvas_size * 0.035))
    draw.line((margin, int(canvas_size * 0.32), margin, int(canvas_size * 0.68)), fill=orange, width=line_width)
    draw.line((int(canvas_size * 0.27), int(canvas_size * 0.39), int(canvas_size * 0.27), int(canvas_size * 0.61)), fill=orange, width=line_width)

    image.resize((size, size), Image.Resampling.LANCZOS).save(OUTPUT / f"icon-{size}.png")


for icon_size in (16, 32, 48, 128):
    make_icon(icon_size)

print("Created extension icons")
