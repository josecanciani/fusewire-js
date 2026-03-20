import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use("/js", express.static(join(__dirname, "static", "lib")));

app.get("/", (req, res) => {
	res.json({ status: "ok" });
});

app.listen(port, () => {
	console.log(`Server listening on port ${port}`);
});

export default app;
